import { spawn } from "node:child_process";
import { unwatchFile, watch as watchFsPath, watchFile as watchFsPathPolling } from "node:fs";

/**
 * `rhen mcp --watch`: a small, stable process that an MCP client launches once. It spawns
 * `node <script> mcp` as a child, pipes the client's stdin/stdout through it, and — because the whole
 * point is to survive a rebuild of that child — swaps in a freshly spawned child transparently when
 * the running script file changes on disk, without the client ever seeing a dropped connection.
 *
 * This module is deliberately self-contained: it does not import `registry.js`, `cli.js`, or anything
 * else that pulls in the command surface, because the supervisor's value is staying put while all of
 * that changes underneath it. `runSupervisor` is the injectable core (spawn/watch/io all passed in,
 * so tests drive it without a real child process or filesystem); `createProcessChildFactory` and
 * `createFileWatcher` are the real, Node-backed implementations `mcp.ts` wires it to.
 */

export type LineSource = Iterable<string> | AsyncIterable<string> | NodeJS.ReadableStream;

/** One live child process, from the supervisor's point of view — real or faked in tests. */
export interface ChildHandle {
  /** Write one line (no trailing newline) to the child's stdin. */
  send(line: string): void;
  /** Registers a handler for each complete line the child writes to its stdout. */
  onLine(handler: (line: string) => void): void;
  /** Registers a handler for the child's process exit, real or simulated. */
  onExit(handler: (code: number | null) => void): void;
  /** Registers a handler for raw stderr text from the child, forwarded to the supervisor's own stderr. */
  onStderr?(handler: (text: string) => void): void;
  /** Terminates the child. Safe to call more than once or on an already-exited child. */
  kill(): void;
}

export interface SupervisorIo {
  /** Spawns and wires up one new child. Called once at startup and again on every swap/relaunch. */
  spawnChild: () => ChildHandle;
  /** Registers a callback fired once per (already-debounced) file change; returns an unsubscribe. */
  watchFile: (onChange: () => void) => () => void;
  /** The client's side of the protocol: lines in... */
  stdin: LineSource;
  /** ...and lines out. Never anything but protocol JSON — logging goes to `stderr`. */
  stdout: (line: string) => void;
  /** Diagnostic logging only. Must never be mistaken for the protocol channel. */
  stderr: (line: string) => void;
  /** Overridable delay primitive, so tests don't wait on real timers. Defaults to a real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when the crash backoff is exhausted. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** How long to wait for the outgoing child to finish its in-flight requests before killing it. Default 3000. */
  drainTimeoutMs?: number;
  /** Backoff delays between crash relaunch attempts; giving up after the list is exhausted. Default [1000, 2000, 5000]. */
  crashBackoffMs?: number[];
}

const DEFAULT_DRAIN_TIMEOUT_MS = 3000;
const DEFAULT_CRASH_BACKOFF_MS = [1000, 2000, 5000];
/** How long a relaunched child must stay up before a later crash resets the backoff back to its first step. */
const STABILITY_WINDOW_MS = 2000;
const LIST_CHANGED_NOTIFICATION = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultExit(code: number): void {
  process.exit(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface ParsedMessage {
  hasId: boolean;
  id: unknown;
  method: string | undefined;
}

function tryParseMessage(line: string): ParsedMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value)) return null;
    return {
      hasId: Object.hasOwn(value, "id"),
      id: value.id,
      method: typeof value.method === "string" ? value.method : undefined
    };
  } catch {
    return null;
  }
}

/** Parses a JSON-RPC line and replaces its `id`, for replaying a recorded request under a private id. */
function withSubstitutedId(line: string, id: string): string {
  const parsed = JSON.parse(line) as Record<string, unknown>;
  parsed.id = id;
  return JSON.stringify(parsed);
}

function restartErrorResponse(id: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "server restarted, retry" } });
}

/**
 * Yields complete lines from any of the shapes `stdin` can take. Deliberately a near-duplicate of
 * `mcp.ts`'s own `toLines` rather than an import of it — see the module doc for why.
 */
async function* toLines(input: LineSource): AsyncGenerator<string> {
  const maybeStream = input as NodeJS.ReadableStream;
  if (typeof maybeStream.pipe !== "function") {
    yield* input as Iterable<string> | AsyncIterable<string>;
    return;
  }
  let buffer = "";
  for await (const chunk of maybeStream) {
    buffer += typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      yield buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  }
  if (buffer.length > 0) yield buffer.replace(/\r$/, "");
}

/**
 * Drives the supervisor loop until `io.stdin` ends. See the module doc for the swap protocol; in
 * short: one child is "current" at a time, its in-flight request ids are tracked, and a restart
 * (file change or crash) buffers new client lines, drains or force-fails the old child's in-flight
 * requests, spawns a replacement, replays the recorded handshake into it without exposing that
 * replay to the client, then flushes what was buffered and announces `tools/list_changed`.
 */
export async function runSupervisor(io: SupervisorIo): Promise<void> {
  const sleep = io.sleep ?? defaultSleep;
  const exit = io.exit ?? defaultExit;
  const drainTimeoutMs = io.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const crashBackoffMs = io.crashBackoffMs ?? DEFAULT_CRASH_BACKOFF_MS;

  let currentChild: ChildHandle | null = null;
  /** True from the moment a manual (file-change) swap starts retiring the old child until the new one is ready. */
  let draining = false;
  /** Old children currently being retired by `swap()` — their exit (crash or our own kill) is swap's business, not a crash to relaunch from. */
  const swapping = new Set<ChildHandle>();
  /** Children we killed on purpose outside of a swap (shutdown) — their exit is expected, not a crash. */
  const intentionalKills = new Set<ChildHandle>();

  let recordedInitializeLine: string | null = null;
  let recordedInitializedLine: string | null = null;

  const inFlight = new Set<unknown>();
  let drainWaiters: Array<() => void> = [];
  const bufferedLines: string[] = [];

  const pendingReplays = new Map<string, (result: Record<string, unknown> | null) => void>();
  let replayCounter = 0;
  let lastKnownVersion: string | undefined;
  let crashAttempt = 0;

  function markAnswered(id: unknown): void {
    inFlight.delete(id);
    if (inFlight.size === 0 && drainWaiters.length > 0) {
      const waiters = drainWaiters;
      drainWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  function waitForDrain(): Promise<void> {
    if (inFlight.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      drainWaiters.push(done);
      void sleep(drainTimeoutMs).then(done);
    });
  }

  /** Every id still waiting on the retiring child gets an immediate error; the client is never left hanging. */
  function failInFlight(): void {
    for (const id of inFlight) io.stdout(restartErrorResponse(id));
    inFlight.clear();
    drainWaiters = [];
  }

  function flushBuffered(): void {
    const lines = bufferedLines.splice(0);
    for (const line of lines) {
      const parsed = tryParseMessage(line);
      if (parsed?.hasId) inFlight.add(parsed.id);
      currentChild?.send(line);
    }
  }

  function handleChildLine(child: ChildHandle, line: string): void {
    const parsed = tryParseMessage(line);
    if (parsed?.hasId && typeof parsed.id === "string" && pendingReplays.has(parsed.id)) {
      const resolve = pendingReplays.get(parsed.id);
      pendingReplays.delete(parsed.id);
      let result: Record<string, unknown> | null = null;
      try {
        result = JSON.parse(line) as Record<string, unknown>;
      } catch {
        result = null;
      }
      resolve?.(result);
      return; // the client already has an answer to this request's real id — never forward the replay's.
    }
    if (child !== currentChild) return; // stray output from a child we've already retired; drop it.
    if (parsed?.hasId) markAnswered(parsed.id);
    io.stdout(line);
  }

  function handleChildExit(child: ChildHandle): void {
    if (intentionalKills.delete(child)) return;
    if (swapping.delete(child)) return; // swap() itself drives what happens next, crashed or not.
    if (child !== currentChild) return;
    currentChild = null;
    failInFlight();
    crashAttempt += 1;
    if (crashAttempt > crashBackoffMs.length) {
      io.stderr(`[mcp --watch] child exited ${crashAttempt} times in a row; giving up.`);
      exit(1);
      return;
    }
    const delay = crashBackoffMs[crashAttempt - 1] ?? 0;
    io.stderr(
      `[mcp --watch] child exited unexpectedly; relaunching in ${delay}ms (attempt ${crashAttempt}/${crashBackoffMs.length}).`
    );
    void relaunchAfterCrash(delay);
  }

  async function relaunchAfterCrash(delay: number): Promise<void> {
    await sleep(delay);
    const child = await spawnChildAndReplay();
    io.stderr(`[mcp --watch] child relaunched (version ${lastKnownVersion ?? "unknown"}).`);
    flushBuffered();
    const stableAt = child;
    void sleep(STABILITY_WINDOW_MS).then(() => {
      if (currentChild === stableAt) crashAttempt = 0;
    });
  }

  /** Spawns one child and, if a handshake has been recorded, replays it in without exposing the replay to the client. */
  async function spawnChildAndReplay(): Promise<ChildHandle> {
    const child = io.spawnChild();
    currentChild = child;
    child.onExit(() => handleChildExit(child));
    child.onLine((line) => handleChildLine(child, line));
    child.onStderr?.((text) => io.stderr(`[mcp child] ${text.replace(/\n+$/, "")}`));

    if (recordedInitializeLine) {
      const replayId = `__mcp_supervisor_reinit_${(replayCounter += 1)}__`;
      const responded = new Promise<Record<string, unknown> | null>((resolve) => {
        pendingReplays.set(replayId, resolve);
      });
      child.send(withSubstitutedId(recordedInitializeLine, replayId));
      const result = await Promise.race([responded, sleep(drainTimeoutMs).then(() => null)]);
      pendingReplays.delete(replayId);
      const serverInfo = result && isRecord(result.result) ? result.result.serverInfo : undefined;
      const version = isRecord(serverInfo) && typeof serverInfo.version === "string" ? serverInfo.version : undefined;
      if (version) lastKnownVersion = version;
      if (recordedInitializedLine) child.send(recordedInitializedLine);
    }
    return child;
  }

  async function swap(reason: string): Promise<void> {
    if (draining) return; // a restart is already in progress — this change rides along with it.
    draining = true;
    const oldChild = currentChild;
    if (oldChild) {
      swapping.add(oldChild);
      await waitForDrain();
      failInFlight();
      oldChild.kill();
    }
    currentChild = null;
    await spawnChildAndReplay();
    draining = false;
    flushBuffered();
    io.stdout(LIST_CHANGED_NOTIFICATION);
    io.stderr(`[mcp --watch] restarted (${reason}); now serving version ${lastKnownVersion ?? "unknown"}.`);
  }

  function killChildNow(child: ChildHandle | null): void {
    if (!child) return;
    intentionalKills.add(child);
    child.kill();
  }

  function handleClientLine(line: string): void {
    const parsed = tryParseMessage(line);
    if (parsed?.method === "initialize" && recordedInitializeLine === null) recordedInitializeLine = line;
    if (parsed?.method === "notifications/initialized" && recordedInitializedLine === null)
      recordedInitializedLine = line;
    if (draining || currentChild === null) {
      bufferedLines.push(line);
      return;
    }
    if (parsed?.hasId) inFlight.add(parsed.id);
    currentChild.send(line);
  }

  await spawnChildAndReplay(); // the initial child: no handshake recorded yet, so this is a plain spawn.
  const stopWatching = io.watchFile(() => {
    void swap("build changed");
  });

  try {
    for await (const line of toLines(io.stdin)) {
      if (line.trim() === "") continue;
      handleClientLine(line);
    }
  } finally {
    stopWatching();
    killChildNow(currentChild);
  }
}

// ---------------------------------------------------------------------------------------------
// Real, Node-backed implementations. Kept below the injectable core and imported only from mcp.ts.
// ---------------------------------------------------------------------------------------------

/**
 * Spawns `node <scriptPath> mcp [...extraArgs]` (never `--watch` — the child always runs the plain
 * server) as a `ChildHandle`. `extraArgs` carries flags that govern the whole session rather than any
 * one tool call — `--read-only` and `--state-file <path>` — so the watched child serves the same
 * restricted table the supervisor itself was started with.
 */
export function createProcessChildFactory(scriptPath: string, extraArgs: readonly string[] = []): () => ChildHandle {
  return () => {
    const child = spawn(process.execPath, [scriptPath, "mcp", ...extraArgs], { stdio: ["pipe", "pipe", "pipe"] });
    const lineHandlers: Array<(line: string) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];
    const stderrHandlers: Array<(text: string) => void> = [];
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line.trim() !== "") for (const handler of lineHandlers) handler(line);
        index = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      for (const handler of stderrHandlers) handler(chunk.toString("utf8"));
    });
    child.on("exit", (code) => {
      for (const handler of exitHandlers) handler(code);
    });
    return {
      send: (line) => {
        child.stdin.write(`${line}\n`);
      },
      onLine: (handler) => lineHandlers.push(handler),
      onExit: (handler) => exitHandlers.push(handler),
      onStderr: (handler) => stderrHandlers.push(handler),
      kill: () => {
        child.kill();
      }
    };
  };
}

/**
 * Watches `path` for changes, debounced by `debounceMs` (default 500). Tries `fs.watch` first (event
 * driven); if that throws at setup (some filesystems refuse it) falls back to `fs.watchFile` polling
 * once a second, per the spec. Returns a factory matching `SupervisorIo["watchFile"]`.
 */
export function createFileWatcher(path: string, debounceMs = 500): (onChange: () => void) => () => void {
  return (onChange) => {
    let timer: NodeJS.Timeout | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, debounceMs);
    };
    try {
      const watcher = watchFsPath(path, { persistent: true }, () => trigger());
      return () => {
        watcher.close();
        if (timer) clearTimeout(timer);
      };
    } catch {
      watchFsPathPolling(path, { interval: 1000, persistent: true }, () => trigger());
      return () => {
        unwatchFile(path);
        if (timer) clearTimeout(timer);
      };
    }
  };
}
