import { describe, expect, it } from "vitest";
import { triggerResponseLevel } from "./drain-log";

describe("triggerResponseLevel", () => {
  it("logs 2xx as info", () => {
    expect(triggerResponseLevel(200)).toBe("info");
    expect(triggerResponseLevel(204)).toBe("info");
  });
  it("logs 4xx and 5xx as error", () => {
    expect(triggerResponseLevel(403)).toBe("error");
    expect(triggerResponseLevel(500)).toBe("error");
    expect(triggerResponseLevel(503)).toBe("error");
  });
});

import { postTrigger, runLeaveByPushTick } from "./drain-log";

describe("postTrigger", () => {
  const base = {
    url: "http://portal/x",
    init: {},
    okMessage: "ok",
    errorMessage: "bad",
    failedMessage: "failed",
    workerId: "w"
  };
  it("reports a 2xx as ran and logs info", async () => {
    const lines: { stream: string; line: Record<string, unknown> }[] = [];
    const ran = await postTrigger({
      ...base,
      fetchImpl: async () => new Response("{}", { status: 200 }),
      write: (stream, line) => lines.push({ stream, line })
    });
    expect(ran).toBe(true);
    expect(lines).toEqual([
      { stream: "stdout", line: expect.objectContaining({ level: "info", message: "ok", httpStatus: 200 }) }
    ]);
  });
  it("does not count a 500 as ran and logs error", async () => {
    const lines: { stream: string; line: Record<string, unknown> }[] = [];
    const ran = await postTrigger({
      ...base,
      fetchImpl: async () => new Response("no", { status: 500 }),
      write: (stream, line) => lines.push({ stream, line })
    });
    expect(ran).toBe(false);
    expect(lines).toEqual([
      { stream: "stderr", line: expect.objectContaining({ level: "error", message: "bad", httpStatus: 500 }) }
    ]);
  });
  it("does not count a throw as ran", async () => {
    const lines: { stream: string; line: Record<string, unknown> }[] = [];
    const ran = await postTrigger({
      ...base,
      fetchImpl: async () => {
        throw new Error("boom");
      },
      write: (stream, line) => lines.push({ stream, line })
    });
    expect(ran).toBe(false);
    expect(lines[0]?.line).toEqual(expect.objectContaining({ level: "error", message: "failed", error: "boom" }));
  });
});

describe("runLeaveByPushTick", () => {
  it("still drains when the enqueue throws", async () => {
    const calls: string[] = [];
    await runLeaveByPushTick({
      enqueue: async () => {
        throw new Error("db blip");
      },
      drain: async () => {
        calls.push("drain");
      },
      onEnqueueError: () => calls.push("enqueue-error")
    });
    expect(calls).toEqual(["enqueue-error", "drain"]);
  });
  it("skips the drain only when there is none", async () => {
    const calls: string[] = [];
    await runLeaveByPushTick({
      enqueue: async () => void calls.push("enqueue"),
      drain: null,
      onEnqueueError: () => {}
    });
    expect(calls).toEqual(["enqueue"]);
  });
});
