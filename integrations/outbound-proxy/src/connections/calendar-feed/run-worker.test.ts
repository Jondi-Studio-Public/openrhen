import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultWorkerUrl, FeedParseError, parseFeedInWorker } from "./run-worker.js";

const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const enc = new TextEncoder();
let dir = "";
let builtWorker: URL;
const request = (body: Uint8Array) => ({
  body,
  now: "2026-11-01T00:00:00Z",
  windowStart: "2026-10-01T00:00:00Z",
  windowEnd: "2027-01-01T00:00:00Z",
  ownerTimeZone: "Europe/London"
});
const feed = (n: number, extra = "") =>
  enc.encode(
    [
      "BEGIN:VCALENDAR",
      ...Array.from(
        { length: n },
        (_v, i) =>
          `BEGIN:VEVENT\r\nUID:e${i}@example.com\r\nDTSTART:20261105T100000Z\r\nDTEND:20261105T110000Z\r\nSUMMARY:Event ${i}${extra}\r\nEND:VEVENT`
      ),
      "END:VCALENDAR",
      ""
    ].join("\r\n")
  );

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "feed-worker-"));
  // The real production build, so the bundle (not the source) is what these tests run.
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: packageDir, stdio: "pipe" });
  builtWorker = pathToFileURL(join(packageDir, "dist", "calendar-feed-worker.js"));
  mkdirSync(join(dir, "w"));
  writeFileSync(join(dir, "w", "spin.mjs"), "for (;;) {}\n");
  writeFileSync(
    join(dir, "w", "hog.mjs"),
    "const keep = []; for (;;) keep.push(new Array(1e5).fill(Math.random()));\n"
  );
  writeFileSync(
    join(dir, "w", "env.mjs"),
    "import { parentPort } from 'node:worker_threads'; parentPort.postMessage({ ok: true, result: { env: Object.keys(process.env) } });\n"
  );
  writeFileSync(join(dir, "w", "throw.mjs"), "throw new Error('boom');\n");
  writeFileSync(join(dir, "w", "quiet-exit.mjs"), "process.exit(0);\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the built worker (production bundle)", () => {
  it("is emitted beside main.js and parses a feed", async () => {
    expect(existsSync(join(packageDir, "dist", "main.js"))).toBe(true);
    const result = await parseFeedInWorker(request(feed(3)), { workerUrl: builtWorker });
    expect(result.events.map((e) => e.title)).toEqual(["Event 0", "Event 1", "Event 2"]);
    expect(result.parseComplete).toBe(true);
  });
  it("resolves the sibling calendar-feed-worker.js from a bundle URL and worker.ts from source", () => {
    expect(defaultWorkerUrl("file:///app/main.js").href).toBe("file:///app/calendar-feed-worker.js");
    expect(defaultWorkerUrl("file:///src/connections/calendar-feed/run-worker.ts").href).toBe(
      "file:///src/connections/calendar-feed/worker.ts"
    );
  });
  it("parses 5,000 events in a 5 MB body at the cap within the 64 MB heap", async () => {
    const pad = "x".repeat(900);
    const body = feed(5000, pad);
    expect(body.byteLength).toBeGreaterThan(5_000_000 * 0.95);
    const result = await parseFeedInWorker(
      request(body.byteLength > 5 * 1024 * 1024 ? body.slice(0, 5 * 1024 * 1024) : body),
      { workerUrl: builtWorker, timeoutMs: 20_000 }
    );
    expect(result.veventCount).toBeGreaterThan(4000);
    expect(result.events.length).toBeLessThanOrEqual(1500);
  });
  it("copies a body that is a view into a larger buffer instead of detaching or shipping the pool", async () => {
    const pool = new Uint8Array(feed(1).length + 100);
    const feedBytes = feed(1);
    pool.set(feedBytes, 50);
    const view = pool.subarray(50, 50 + feedBytes.length);
    const result = await parseFeedInWorker(request(view), { workerUrl: builtWorker });
    expect(result.events).toHaveLength(1);
    expect(pool.buffer.byteLength).toBeGreaterThan(0); // not detached
  });
  it("hands a whole buffer over (the caller's copy is detached)", async () => {
    const own = feed(1);
    await parseFeedInWorker(request(own), { workerUrl: builtWorker });
    expect(own.byteLength).toBe(0);
  });
});

describe("the dev worker (source under tsx)", () => {
  it("runs worker.ts with the tsx loader", async () => {
    const result = await parseFeedInWorker(request(feed(2)), {
      workerUrl: new URL("./worker.ts", import.meta.url),
      execArgv: ["--import", "tsx"]
    });
    expect(result.events).toHaveLength(2);
  });
});

describe("limits", () => {
  const w = (name: string) => pathToFileURL(join(dir, "w", name));
  it("kills a worker stuck in a tight loop at the timeout", async () => {
    const started = Date.now();
    await expect(
      parseFeedInWorker(request(feed(1)), { workerUrl: w("spin.mjs"), timeoutMs: 400 })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  it("reports a heap overrun as memory", async () => {
    await expect(
      parseFeedInWorker(request(feed(1)), { workerUrl: w("hog.mjs"), heapMb: 16, timeoutMs: 15_000 })
    ).rejects.toMatchObject({ code: "memory" });
  });
  it("gives the worker no environment", async () => {
    process.env.FEED_WORKER_TEST_SECRET = "s3cret";
    try {
      const result = (await parseFeedInWorker(request(feed(1)), { workerUrl: w("env.mjs") })) as unknown as {
        env: string[];
      };
      expect(result.env).toEqual([]);
    } finally {
      delete process.env.FEED_WORKER_TEST_SECRET;
    }
  });
  it("maps a throwing or silently exiting worker to crash, with no feed content in the message", async () => {
    await expect(
      parseFeedInWorker(request(feed(1, "SECRET-TITLE")), { workerUrl: w("throw.mjs") })
    ).rejects.toMatchObject({ code: "crash" });
    const quiet = await parseFeedInWorker(request(feed(1)), { workerUrl: w("quiet-exit.mjs") }).catch(
      (e: unknown) => e
    );
    expect(quiet).toBeInstanceOf(FeedParseError);
    expect(String((quiet as Error).message)).not.toContain("SECRET");
  });
  it("honours an abort and refuses to start when already aborted", async () => {
    const early = new AbortController();
    early.abort();
    await expect(
      parseFeedInWorker(request(feed(1)), { workerUrl: builtWorker, signal: early.signal })
    ).rejects.toMatchObject({ code: "aborted" });
    const later = new AbortController();
    const pending = parseFeedInWorker(request(feed(1)), {
      workerUrl: w("spin.mjs"),
      signal: later.signal,
      timeoutMs: 10_000
    });
    setTimeout(() => later.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });
  it("rejects a bad window as bad_request", async () => {
    await expect(
      parseFeedInWorker({ ...request(feed(1)), windowEnd: "2026-01-01T00:00:00Z" }, { workerUrl: builtWorker })
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});
