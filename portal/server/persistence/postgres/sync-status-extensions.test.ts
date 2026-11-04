import { describe, expect, it } from "vitest";
import {
  isFailingSyncStatus,
  lastSyncRunAt,
  readExtensionSyncStatuses,
  registerSyncStatusExtension
} from "./sync-status-extensions";
import type { Sql } from "./sql-pool";

const sql = {} as Sql;

describe("sync status extensions", () => {
  it("reports nothing until a provider registers", async () => {
    expect(await readExtensionSyncStatuses(sql)).toEqual([]);
  });

  it("reads each registered provider that has recorded a status, once per provider", async () => {
    const status = { lastSuccessAt: "2026-10-01T00:00:00.000Z", lastErrorAt: null, consecutiveFailures: 0 };
    registerSyncStatusExtension({ provider: "example", read: async () => status });
    registerSyncStatusExtension({ provider: "example", read: async () => null });
    registerSyncStatusExtension({ provider: "silent", read: async () => null });
    expect(await readExtensionSyncStatuses(sql)).toEqual([{ provider: "example", ...status }]);
  });

  it("reads failures in a row, or an error newer than the last success, as failing", () => {
    const ok = "2026-10-01T00:00:00.000Z";
    const later = "2026-10-02T00:00:00.000Z";
    expect(isFailingSyncStatus({ lastSuccessAt: ok, lastErrorAt: null, consecutiveFailures: 0 })).toBe(false);
    expect(isFailingSyncStatus({ lastSuccessAt: ok, lastErrorAt: null, consecutiveFailures: 1 })).toBe(true);
    expect(isFailingSyncStatus({ lastSuccessAt: ok, lastErrorAt: later, consecutiveFailures: 0 })).toBe(true);
    expect(isFailingSyncStatus({ lastSuccessAt: later, lastErrorAt: ok, consecutiveFailures: 0 })).toBe(false);
    expect(isFailingSyncStatus({ lastSuccessAt: null, lastErrorAt: ok, consecutiveFailures: 0 })).toBe(true);
  });

  it("dates the last run by the later of the last success and the last error", () => {
    expect(lastSyncRunAt({ lastSuccessAt: "2026-10-01", lastErrorAt: "2026-10-02", consecutiveFailures: 0 })).toBe(
      "2026-10-02"
    );
    expect(lastSyncRunAt({ lastSuccessAt: null, lastErrorAt: null, consecutiveFailures: 0 })).toBeNull();
  });
});
