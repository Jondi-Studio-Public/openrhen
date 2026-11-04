import { describe, expect, it } from "vitest";
import { runSupervisor, type ChildHandle, type SupervisorIo } from "../src/commands/mcp-supervisor.js";

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

/** A scripted stand-in for one child process: records what it was sent, and lets a test drive its output. */
class FakeChild implements ChildHandle {
  readonly sent: string[] = [];
  killed = false;
  private lineHandlers: Array<(line: string) => void> = [];
  private exitHandlers: Array<(code: number | null) => void> = [];

  send(line: string): void {
    this.sent.push(line);
  }
  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }
  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }
  kill(): void {
    this.killed = true;
  }
  /** Simulates this child writing one protocol line to its stdout. */
  emitLine(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }
  /** Simulates this child's process exiting, whether killed or crashed. */
  emitExit(code: number | null = 1): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}

/** An async-iterable line queue the test can push into on demand, standing in for the client's stdin. */
function createStdinQueue() {
  const queued: string[] = [];
  let waiting: ((result: IteratorResult<string>) => void) | null = null;
  let closed = false;
  return {
    push(line: string): void {
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: line, done: false });
      } else {
        queued.push(line);
      }
    },
    close(): void {
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined as unknown as string, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          next(): Promise<IteratorResult<string>> {
            if (queued.length > 0) return Promise.resolve({ value: queued.shift() as string, done: false });
            if (closed) return Promise.resolve({ value: undefined as unknown as string, done: true });
            return new Promise((resolve) => {
              waiting = resolve;
            });
          }
        };
      }
    } as AsyncIterable<string>
  };
}

/** Lets queued microtasks (promise chains inside the supervisor) settle before the test asserts. */
async function tick(times = 5): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
}

/** Resolves on the next microtask — every internal wait loses its race to an explicit test action. */
function immediateSleep(): Promise<void> {
  return Promise.resolve();
}
/** Never resolves — every internal wait can only be settled by the test explicitly driving a response. */
function neverSleep(): Promise<void> {
  return new Promise(() => {});
}
/**
 * Resolves quickly for short delays (the crash backoff values a test configures) but never resolves
 * for long ones (the fixed drain timeout and post-relaunch stability window), so a test can drive the
 * backoff schedule deterministically without the stability window's own timer quietly resetting it.
 */
function sleepShortOnly(thresholdMs: number): (ms: number) => Promise<void> {
  return (ms) => (ms < thresholdMs ? Promise.resolve() : new Promise(() => {}));
}

interface Harness {
  stdin: ReturnType<typeof createStdinQueue>;
  stdoutLines: string[];
  stderrLines: string[];
  children: FakeChild[];
  exitCalls: number[];
  triggerChange: () => void;
}

function startSupervisor(overrides: Partial<SupervisorIo> = {}): Harness {
  const stdin = createStdinQueue();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];
  const children: FakeChild[] = [];
  const exitCalls: number[] = [];
  let onChange: (() => void) | null = null;
  const io: SupervisorIo = {
    spawnChild: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    watchFile: (handler) => {
      onChange = handler;
      return () => {
        onChange = null;
      };
    },
    stdin: stdin.iterable,
    stdout: (line) => stdoutLines.push(line),
    stderr: (line) => stderrLines.push(line),
    sleep: immediateSleep,
    exit: (code) => exitCalls.push(code),
    ...overrides
  };
  void runSupervisor(io);
  return {
    stdin,
    stdoutLines,
    stderrLines,
    children,
    exitCalls,
    triggerChange: () => {
      if (!onChange) throw new Error("watchFile's onChange was never registered");
      onChange();
    }
  };
}

const LIST_CHANGED = jsonLine({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

describe("mcp-supervisor: startup", () => {
  it("spawns exactly one child at startup, with no handshake to replay yet", async () => {
    const harness = startSupervisor();
    await tick();
    expect(harness.children).toHaveLength(1);
    expect(harness.children[0]?.sent).toEqual([]);
  });
});

describe("mcp-supervisor: swap on file change", () => {
  it("records initialize/initialized, replays them into the new child under a private id, and swallows the replay's response", async () => {
    // No requests left in flight at swap time, so waitForDrain resolves synchronously without touching sleep.
    const harness = startSupervisor({ sleep: neverSleep });
    await tick();
    const child1 = harness.children[0] as FakeChild;

    const initReq = jsonLine({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" }
    });
    harness.stdin.push(initReq);
    await tick();
    expect(child1.sent).toEqual([initReq]);

    const initRes = jsonLine({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "rhen", version: "1.0.0" } }
    });
    child1.emitLine(initRes);
    await tick();
    expect(harness.stdoutLines).toEqual([initRes]); // forwarded straight through, unlike a replay's response

    const initializedNotif = jsonLine({ jsonrpc: "2.0", method: "notifications/initialized" });
    harness.stdin.push(initializedNotif);
    await tick();
    expect(child1.sent).toContain(initializedNotif);

    harness.triggerChange();
    await tick();

    expect(harness.children).toHaveLength(2);
    const child2 = harness.children[1] as FakeChild;
    expect(child1.killed).toBe(true);

    const replayLine = child2.sent.find((line) => (JSON.parse(line) as { method?: string }).method === "initialize");
    expect(replayLine).toBeDefined();
    const replay = JSON.parse(replayLine as string) as { id: unknown; params: unknown };
    expect(replay.params).toEqual({ protocolVersion: "2025-06-18" });
    expect(replay.id).not.toBe(1); // a private id, not the client's original

    const replayResponseLine = jsonLine({
      jsonrpc: "2.0",
      id: replay.id,
      result: { serverInfo: { name: "rhen", version: "1.1.0" } }
    });
    child2.emitLine(replayResponseLine);
    await tick();

    // the replay's own response never reaches the client — it already has an answer to id 1. The only
    // new stdout line the swap produces is the list_changed notification below.
    expect(harness.stdoutLines).not.toContain(replayResponseLine);
    expect(child2.sent).toContain(initializedNotif); // the recorded notification was replayed too

    // the client is told to refresh its tool list once the swap completes
    expect(harness.stdoutLines.at(-1)).toBe(LIST_CHANGED);
  });

  it("buffers client lines sent mid-swap and flushes them into the new child only, once it is ready", async () => {
    const harness = startSupervisor({ sleep: neverSleep });
    await tick();
    const child1 = harness.children[0] as FakeChild;

    // get to a clean, drained state (no in-flight requests) so the swap doesn't need to wait on sleep at all
    const initReq = jsonLine({ jsonrpc: "2.0", id: "a", method: "initialize", params: {} });
    harness.stdin.push(initReq);
    await tick();
    child1.emitLine(jsonLine({ jsonrpc: "2.0", id: "a", result: { serverInfo: { name: "rhen", version: "1.0.0" } } }));
    await tick();

    harness.triggerChange();
    await tick();
    const child2 = harness.children[1] as FakeChild;
    const sentToChild2SoFar = child2.sent.length;

    // client fires off a tool call while child2 is still mid-handshake (nothing has answered the replay yet)
    const toolCall = jsonLine({
      jsonrpc: "2.0",
      id: "call-1",
      method: "tools/call",
      params: { name: "rhen_status" }
    });
    harness.stdin.push(toolCall);
    await tick();

    expect(child1.sent).not.toContain(toolCall); // never sent to the retiring child
    expect(child2.sent.length).toBe(sentToChild2SoFar); // nor to the new one yet — it's buffered

    // the replay resolves, unblocking the swap
    const replayLine = child2.sent.find((line) => (JSON.parse(line) as { method?: string }).method === "initialize");
    const replay = JSON.parse(replayLine as string) as { id: unknown };
    child2.emitLine(
      jsonLine({ jsonrpc: "2.0", id: replay.id, result: { serverInfo: { name: "rhen", version: "1.0.0" } } })
    );
    await tick();

    expect(child2.sent).toContain(toolCall); // flushed once the swap finished

    child2.emitLine(jsonLine({ jsonrpc: "2.0", id: "call-1", result: { content: [], isError: false } }));
    await tick();
    expect(harness.stdoutLines).toContain(
      jsonLine({ jsonrpc: "2.0", id: "call-1", result: { content: [], isError: false } })
    );
  });

  it("errors out any request still in flight on the old child once the drain timeout is reached", async () => {
    // sleep resolves immediately, so waitForDrain's timeout branch always wins over an unanswered request.
    const harness = startSupervisor({ sleep: immediateSleep });
    await tick();
    const child1 = harness.children[0] as FakeChild;

    const pendingCall = jsonLine({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "rhen_status" }
    });
    harness.stdin.push(pendingCall);
    await tick();
    expect(child1.sent).toContain(pendingCall);

    harness.triggerChange();
    await tick(10);

    expect(harness.stdoutLines).toContain(
      jsonLine({ jsonrpc: "2.0", id: 42, error: { code: -32000, message: "server restarted, retry" } })
    );
    expect(child1.killed).toBe(true);
    expect(harness.children).toHaveLength(2);
  });

  it("does nothing on a second file-change notification while a swap is already in progress", async () => {
    // sleep never resolves, and a handshake is recorded below, so the swap's replay-await genuinely
    // never settles on its own — the only way it would resolve is a response this test never sends.
    const harness = startSupervisor({ sleep: neverSleep });
    await tick();
    const child1 = harness.children[0] as FakeChild;
    const initReq = jsonLine({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    harness.stdin.push(initReq);
    await tick();
    child1.emitLine(jsonLine({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "rhen", version: "1.0.0" } } }));
    await tick();

    harness.triggerChange();
    await tick();
    expect(harness.children).toHaveLength(2); // mid-swap: child2 spawned, its replay reply never arrives

    harness.triggerChange(); // ignored — draining is already true
    await tick();
    expect(harness.children).toHaveLength(2);
  });
});

describe("mcp-supervisor: crash relaunch", () => {
  it("relaunches with backoff after an unexpected exit, and gives up after the backoff is exhausted", async () => {
    // Backoff delays (1ms) resolve right away; the 2000ms post-relaunch stability window never does, so
    // it can't quietly reset the attempt counter between the scripted crashes below.
    const harness = startSupervisor({ sleep: sleepShortOnly(100), crashBackoffMs: [1, 1, 1] });
    await tick();
    expect(harness.children).toHaveLength(1);

    // three crashes are within budget: each gets relaunched
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const dying = harness.children.at(-1) as FakeChild;
      dying.emitExit(1);
      await tick(10);
      expect(harness.children).toHaveLength(1 + attempt);
      expect(harness.exitCalls).toHaveLength(0);
    }

    // the fourth crash exceeds the backoff list — the supervisor gives up instead of relaunching again
    const lastChild = harness.children.at(-1) as FakeChild;
    lastChild.emitExit(1);
    await tick(10);
    expect(harness.children).toHaveLength(4); // no fifth spawn
    expect(harness.exitCalls).toEqual([1]);
  });

  it("does not treat a deliberately killed old child (from a swap) as a crash", async () => {
    const harness = startSupervisor({ sleep: neverSleep });
    await tick();
    const child1 = harness.children[0] as FakeChild;
    harness.triggerChange();
    await tick();
    // swap() calls child1.kill() itself; simulate the resulting process exit exactly as Node would deliver it
    child1.emitExit(null);
    await tick();
    // only the one child spawned by the swap so far — no extra crash-relaunch spawn was triggered
    expect(harness.children).toHaveLength(2);
    expect(harness.exitCalls).toHaveLength(0);
  });
});

describe("mcp-supervisor: logging discipline", () => {
  it("never writes diagnostic text to stdout, and every stdout line is protocol JSON", async () => {
    const harness = startSupervisor({ sleep: sleepShortOnly(100), crashBackoffMs: [1] });
    await tick();
    const child1 = harness.children[0] as FakeChild;
    harness.triggerChange();
    await tick(10);
    (harness.children.at(-1) as FakeChild).emitExit(1);
    await tick(10);
    (harness.children.at(-1) as FakeChild).emitExit(1);
    await tick(10);

    expect(harness.stderrLines.length).toBeGreaterThan(0);
    for (const line of harness.stderrLines) expect(line).toContain("[mcp");
    for (const line of harness.stdoutLines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe("2.0");
    }
    void child1;
  });
});
