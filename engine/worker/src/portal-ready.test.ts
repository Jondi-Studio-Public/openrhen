import { describe, expect, it } from "vitest";
import { PORTAL_READY_PATH, waitForPortal } from "./portal-ready.js";

function harness(failures: number) {
  let clock = 0;
  let calls = 0;
  const urls: string[] = [];
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    urls,
    calls: () => calls,
    options: {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      log: (line: Record<string, unknown>) => lines.push(line),
      fetch: async (url: string) => {
        urls.push(url);
        calls += 1;
        if (calls <= failures) throw new TypeError("fetch failed");
        return { ok: true };
      }
    }
  };
}

describe("waitForPortal", () => {
  it("returns ready at once, silently, when the portal already answers", async () => {
    const h = harness(0);
    expect(await waitForPortal("http://portal:8787", h.options)).toBe("ready");
    expect(h.lines).toEqual([]);
    expect(h.urls).toEqual([`http://portal:8787${PORTAL_READY_PATH}`]);
  });

  it("succeeds after N failures, logging about once per ten seconds at info", async () => {
    const h = harness(25);
    expect(await waitForPortal("http://portal:8787/", h.options)).toBe("ready");
    expect(h.calls()).toBe(26);
    const waiting = h.lines.filter((l) => String(l.message).startsWith("Waiting"));
    expect(waiting.length).toBe(3);
    expect(h.lines.every((l) => l.level === "info")).toBe(true);
    expect(h.urls[0]).toBe(`http://portal:8787${PORTAL_READY_PATH}`);
  });

  it("treats a non-2xx answer as not ready", async () => {
    const h = harness(0);
    let n = 0;
    const result = await waitForPortal("http://portal:8787", {
      ...h.options,
      fetch: async () => ({ ok: ++n > 3 })
    });
    expect(result).toBe("ready");
    expect(n).toBe(4);
  });

  it("times out, warns once and proceeds", async () => {
    const h = harness(Number.MAX_SAFE_INTEGER);
    expect(await waitForPortal("http://portal:8787", { ...h.options, timeoutMs: 30_000 })).toBe("timeout");
    const last = h.lines[h.lines.length - 1];
    expect(last?.level).toBe("warn");
    expect(h.lines.filter((l) => l.level === "warn")).toHaveLength(1);
  });

  it("stops waiting when the worker is stopping", async () => {
    const h = harness(Number.MAX_SAFE_INTEGER);
    let stopping = false;
    const sleep = async () => {
      stopping = true;
    };
    expect(await waitForPortal("http://portal:8787", { ...h.options, sleep, isStopping: () => stopping })).toBe(
      "stopped"
    );
  });

  it("never logs credentials, paths or tokens from the URL", async () => {
    const h = harness(15);
    await waitForPortal("http://user:s3cret-pass@portal:8787/path?token=abc123", h.options);
    const text = JSON.stringify(h.lines);
    expect(text).not.toContain("s3cret-pass");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("token");
    expect(text).toContain("http://portal:8787");
  });
});
