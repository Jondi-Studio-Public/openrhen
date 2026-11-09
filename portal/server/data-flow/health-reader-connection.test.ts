import { afterEach, describe, expect, it, vi } from "vitest";
import { withProbeConnection } from "./health-reader";

/** The probe connection's set-up and tear-down, against a stand-in for a reserved connection. */
function fakePool(options: { failReset?: boolean; terminateSurvives?: boolean } = {}) {
  const calls: string[] = [];
  let released = 0;
  const reserved = Object.assign(
    (strings: TemplateStringsArray) => {
      const text = strings.join("?").trim();
      calls.push(text);
      if (options.failReset && text.startsWith("RESET")) return Promise.reject(new Error("reset failed"));
      if (text.includes("pg_terminate_backend"))
        return options.terminateSurvives ? Promise.resolve([]) : Promise.reject(new Error("connection terminated"));
      return Promise.resolve([]);
    },
    {
      release: () => {
        released += 1;
      }
    }
  );
  return { pool: { reserve: async () => reserved } as never, calls, released: () => released };
}

afterEach(() => vi.restoreAllMocks());

describe("withProbeConnection", () => {
  it("sets the limit and read-only mode, and clears both before releasing the connection", async () => {
    const fake = fakePool();
    await expect(withProbeConnection(fake.pool, 1000, async () => "done")).resolves.toBe("done");
    expect(fake.calls[0]).toContain("statement_timeout");
    expect(fake.calls[0]).toContain("default_transaction_read_only");
    expect(fake.calls.slice(1)).toEqual(["RESET statement_timeout", "RESET default_transaction_read_only"]);
    expect(fake.released()).toBe(1);
  });

  it("ends a connection whose RESET failed instead of returning it to the pool, and keeps the original error", async () => {
    const fake = fakePool({ failReset: true });
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      withProbeConnection(fake.pool, 1000, async () => {
        throw new Error("the probes failed");
      })
    ).rejects.toThrow("the probes failed");
    expect(fake.calls.some((call) => call.includes("pg_terminate_backend"))).toBe(true);
    expect(fake.released()).toBe(0);
    expect(logged.mock.calls.join("\n")).toContain("could not be reset");
  });

  it("still releases a connection that survived the attempt to end it", async () => {
    const fake = fakePool({ failReset: true, terminateSurvives: true });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await withProbeConnection(fake.pool, 1000, async () => 1);
    expect(fake.released()).toBe(1);
  });

  it("runs on a handle that cannot be reserved as it is", async () => {
    const handle = {} as never;
    await expect(withProbeConnection(handle, 1000, async (sql) => sql === handle)).resolves.toBe(true);
  });
});
