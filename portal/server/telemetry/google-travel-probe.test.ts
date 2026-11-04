import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `checkGoogleReachability` no longer calls Google itself (`travel-time-model.md`, "One spender"): it
 * only reads back the most recent `travel_matrix` real call `provider_call_telemetry` already holds,
 * from whichever spend made it. Mocked here rather than exercised against a live database — the
 * integration suite (`travel-spend.integration.test.ts`) proves a spend actually writes that row;
 * this proves the probe reads it back correctly and degrades when there is nothing to read.
 */

const queryMock = vi.fn();

vi.mock("@/server/persistence/postgres/sql-pool", () => ({
  sqlPool: () => Object.assign((..._args: unknown[]) => queryMock(), {})
}));

vi.mock("@/server/runtime-env", () => ({
  databaseUrl: () => "postgres://example/test"
}));

async function importProbe() {
  return import("./google-travel-probe");
}

beforeEach(() => {
  queryMock.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe("checkGoogleReachability", () => {
  it("reports skipped when no travel_matrix call has ever been recorded", async () => {
    queryMock.mockResolvedValue([]);
    const { checkGoogleReachability } = await importProbe();
    await expect(checkGoogleReachability()).resolves.toEqual({
      status: "skipped",
      detail: "No travel lookup has been made yet."
    });
  });

  it("reports the last real travel call as checked/ok when it succeeded", async () => {
    queryMock.mockResolvedValue([{ started_at: new Date(), ok: true, error_summary: null }]);
    const { checkGoogleReachability } = await importProbe();
    await expect(checkGoogleReachability()).resolves.toEqual({ status: "checked", ok: true, detail: null });
  });

  it("reports the last real travel call as checked/not-ok, with its error, when it failed", async () => {
    queryMock.mockResolvedValue([{ started_at: new Date(), ok: false, error_summary: "The travel lookup failed." }]);
    const { checkGoogleReachability } = await importProbe();
    await expect(checkGoogleReachability()).resolves.toEqual({
      status: "checked",
      ok: false,
      detail: "The travel lookup failed."
    });
  });

  it("is skipped, not thrown, when no database is configured", async () => {
    vi.doMock("@/server/runtime-env", () => ({ databaseUrl: () => undefined }));
    const { checkGoogleReachability } = await importProbe();
    await expect(checkGoogleReachability()).resolves.toEqual({
      status: "skipped",
      detail: "The database is not configured, so telemetry cannot be read."
    });
  });
});
