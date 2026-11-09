import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { text: string; values: unknown[] }[] = [];
const state = { url: "postgres://test" as string | undefined, failInsert: false };

vi.mock("./ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("./sql-pool", () => ({
  sqlPool: () =>
    Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        calls.push({ text, values });
        if (state.failInsert && text.includes("INSERT")) throw new Error("connection refused");
        return [];
      },
      { json: (value: unknown) => value }
    )
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => state.url }));

const { recordRun, RUN_RETENTION_DAYS } = await import("./run-log");

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
