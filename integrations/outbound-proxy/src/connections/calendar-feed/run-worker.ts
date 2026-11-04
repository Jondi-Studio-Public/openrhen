// Runs the feed parser in a worker thread with a heap cap and a kill timeout (design v4 (c)).
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { ParseRequest, ParseResult } from "./parse.js";

export type FeedParseErrorCode = "timeout" | "memory" | "crash" | "aborted" | "bad_request";

/** Thrown for any parse that did not produce a result. The message never contains feed content. The caller treats every code as an incomplete read. */
export class FeedParseError extends Error {
  constructor(readonly code: FeedParseErrorCode) {
    super(`calendar feed parse failed: ${code}`);
    this.name = "FeedParseError";
  }
}

export interface RunOptions {
  timeoutMs?: number;
  heapMb?: number;
  signal?: AbortSignal;
  /** Override the worker file. Tests use it; production and `tsx` dev resolve it themselves. */
  workerUrl?: URL;
  /** Extra Node flags for the worker, such as `["--import", "tsx"]` to run the .ts worker under a test runner. */
  execArgv?: string[];
}

export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_HEAP_MB = 64;
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
}
function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running--;
}

/**
 * The worker file: in the esbuild bundle (`dist/main.js`) it is the sibling `calendar-feed-worker.js`; from source
 * (`tsx` dev) it is `worker.ts` and the flags of the running process carry the loader.
 */
export function defaultWorkerUrl(moduleUrl: string = import.meta.url): URL {
  return moduleUrl.endsWith(".ts")
    ? new URL("./worker.ts", moduleUrl)
    : new URL("./calendar-feed-worker.js", moduleUrl);
}

function ownBuffer(body: Uint8Array): ArrayBuffer {
  // Only a view that spans its whole ArrayBuffer is transferred; any other (a pooled Buffer, a subarray) is copied so
  // neighbouring bytes are never shipped, and the caller's memory is detached only when it handed the buffer over whole.
  if (body.buffer instanceof ArrayBuffer && body.byteOffset === 0 && body.byteLength === body.buffer.byteLength)
    return body.buffer;
  return body.slice().buffer as ArrayBuffer;
}

export async function parseFeedInWorker(request: ParseRequest, options: RunOptions = {}): Promise<ParseResult> {
  const { signal } = options;
  if (signal?.aborted) throw new FeedParseError("aborted");
  await acquire();
  try {
    if (signal?.aborted) throw new FeedParseError("aborted");
    return await run(request, options);
  } finally {
    release();
  }
}

function run(request: ParseRequest, options: RunOptions): Promise<ParseResult> {
  const url = options.workerUrl ?? defaultWorkerUrl();
  if (url.protocol === "file:" && !existsSync(url)) return Promise.reject(new FeedParseError("crash"));
  const buffer = ownBuffer(request.body);
  const body = new Uint8Array(buffer);
  return new Promise<ParseResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(url, {
      workerData: { ...request, body },
      transferList: [buffer],
      // The proxy holds every provider credential; a worker that parses hostile input gets none of them.
      env: {},
      execArgv: options.execArgv,
      stdout: false,
      stderr: false,
      resourceLimits: {
        maxOldGenerationSizeMb: options.heapMb ?? DEFAULT_HEAP_MB,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4
      }
    });
    const finish = (error: FeedParseError | null, value?: ParseResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value as ParseResult);
    };
    const onAbort = () => finish(new FeedParseError("aborted"));
    const timer = setTimeout(() => finish(new FeedParseError("timeout")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: { ok?: boolean; result?: ParseResult }) => {
      if (message?.ok && message.result) finish(null, message.result);
      else finish(new FeedParseError("crash"));
    });
    worker.once("error", (error: Error & { code?: string }) => {
      finish(
        new FeedParseError(
          error.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? "memory"
            : error instanceof RangeError && /bad window/.test(error.message)
              ? "bad_request"
              : "crash"
        )
      );
    });
    worker.once("messageerror", () => finish(new FeedParseError("crash")));
    worker.once("exit", () => finish(new FeedParseError("crash")));
  });
}
