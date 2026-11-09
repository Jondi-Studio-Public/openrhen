import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { text: string; values: unknown[] }[] = [];
const state = { url: "postgres://test" as string | undefined, failInsert: false, recent: false };

vi.mock("./ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("./sql-pool", () => ({
  sqlPool: () =>
    Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        calls.push({ text, values });
        if (state.failInsert && text.includes("INSERT")) throw new Error("connection refused");
        if (text.includes("SELECT") && state.recent) return [{ one: 1 }];
        return [];
      },
      { json: (value: unknown) => value }
    )
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => state.url }));

const { recordRun, recordRunThrottled, resetRunThrottle, RUN_RETENTION_DAYS } = await import("./run-log");

const run = {
  provider: "import:timeline",
  trigger: "manual" as const,
  status: "synced" as const,
  startedAt: new Date("2026-11-09T01:00:00Z"),
  finishedAt: new Date("2026-11-09T01:00:05Z"),
  summary: { events: 3 }
};

beforeEach(() => {
  calls.length = 0;
  state.url = "postgres://test";
  state.failInsert = false;
  state.recent = false;
  resetRunThrottle();
});

describe("recordRun", () => {
  it("inserts one row, then prunes that provider's rows past the retention window", async () => {
    await recordRun(run);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain("INSERT INTO integration_sync_runs");
    expect(calls[0]!.values).toEqual(
      expect.arrayContaining(["user-1", "import:timeline", "manual", "synced", "2026-11-09T01:00:00.000Z"])
    );
    expect(calls[1]!.text).toContain("DELETE FROM integration_sync_runs");
    expect(calls[1]!.values).toEqual(expect.arrayContaining(["user-1", "import:timeline", RUN_RETENTION_DAYS]));
  });

  it("does nothing without a database", async () => {
    state.url = undefined;
    await expect(recordRun(run)).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("never throws: it logs the error and carries on", async () => {
    state.failInsert = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(recordRun(run)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledOnce();
    expect(String(errors.mock.calls[0]![0])).toContain("connection refused");
    errors.mockRestore();
  });
});

describe("recordRunThrottled", () => {
  const at = new Date("2026-11-09T01:00:00Z");
  const inserts = () => calls.filter((call) => call.text.includes("INSERT INTO"));

  it("writes the first row, then skips the same provider and status for an hour from memory", async () => {
    await recordRunThrottled(run, { now: at });
    expect(inserts()).toHaveLength(1);
    const before = calls.length;
    await recordRunThrottled(run, { now: new Date(at.getTime() + 59 * 60_000) });
    expect(calls.length).toBe(before);
    await recordRunThrottled(run, { now: new Date(at.getTime() + 61 * 60_000) });
    expect(inserts()).toHaveLength(2);
  });

  it("keeps a separate hour for each status and each provider", async () => {
    await recordRunThrottled(run, { now: at });
    await recordRunThrottled({ ...run, status: "failed" }, { now: at });
    await recordRunThrottled({ ...run, provider: "import:spotify" }, { now: at });
    expect(inserts()).toHaveLength(3);
  });

  it("skips when the last row in the database is under an hour old, as after a restart", async () => {
    state.recent = true;
    await recordRunThrottled(run, { now: at });
    expect(inserts()).toHaveLength(0);
  });

  it("writes nothing without a database", async () => {
    state.url = undefined;
    await recordRunThrottled(run, { now: at });
    expect(calls).toHaveLength(0);
  });
});
