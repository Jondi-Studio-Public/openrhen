import { describe, expect, it } from "vitest";
import {
  KEEP_PRE_MIGRATE_DUMPS,
  STALE_PARTIAL_DUMP_MS,
  preMigrateDumpName,
  preMigrateDumpsToPrune,
  stalePartialDumps
} from "./pre-migrate-dump.js";

describe("preMigrateDumpName", () => {
  const now = new Date("2026-10-07T03:04:05.678Z");

  it("stamps UTC to the second and appends the image tag", () => {
    expect(preMigrateDumpName(now, "5962cbe3a1b2")).toBe("pre-migrate-20261007T030405Z-5962cbe3a1b2.dump");
  });

  it("falls back to dev when there is no tag", () => {
    expect(preMigrateDumpName(now, undefined)).toBe("pre-migrate-20261007T030405Z-dev.dump");
    expect(preMigrateDumpName(now, "")).toBe("pre-migrate-20261007T030405Z-dev.dump");
  });

  it("keeps a hostile tag from escaping the directory", () => {
    expect(preMigrateDumpName(now, "../x y")).toBe("pre-migrate-20261007T030405Z-..-x-y.dump");
  });
});

describe("preMigrateDumpsToPrune", () => {
  const name = (day: number) => `pre-migrate-202610${String(day).padStart(2, "0")}T000000Z-abc.dump`;

  it("keeps the newest five and returns the rest", () => {
    const names = [1, 2, 3, 4, 5, 6, 7].map(name);
    expect(KEEP_PRE_MIGRATE_DUMPS).toBe(5);
    expect(preMigrateDumpsToPrune(names)).toEqual([name(2), name(1)]);
  });

  it("deletes nothing at or below the limit", () => {
    expect(preMigrateDumpsToPrune([1, 2, 3, 4, 5].map(name))).toEqual([]);
  });

  it("never touches files that are not pre-migration dumps", () => {
    const names = [...[1, 2, 3, 4, 5, 6].map(name), "notes.txt", "backup-20260101.dump", "pre-migrate-x.dump.partial"];
    expect(preMigrateDumpsToPrune(names)).toEqual([name(1)]);
  });
});

describe("stalePartialDumps", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const partial = (day: number) => `pre-migrate-202610${String(day).padStart(2, "0")}T000000Z-abc.dump.partial`;
  const ago = (ms: number) => now - ms;

  it("returns partials older than the limit and keeps fresh ones", () => {
    expect(STALE_PARTIAL_DUMP_MS).toBe(6 * 60 * 60 * 1000);
    const files = [
      { name: partial(1), mtimeMs: ago(STALE_PARTIAL_DUMP_MS + 1) },
      { name: partial(2), mtimeMs: ago(STALE_PARTIAL_DUMP_MS) },
      { name: partial(3), mtimeMs: ago(5 * 60 * 1000) }
    ];
    expect(stalePartialDumps(files, now)).toEqual([partial(1)]);
  });

  it("takes the age as a parameter", () => {
    expect(stalePartialDumps([{ name: partial(1), mtimeMs: ago(2000) }], now, 1000)).toEqual([partial(1)]);
  });

  it("never touches finished dumps or other files, however old", () => {
    const old = ago(STALE_PARTIAL_DUMP_MS * 10);
    const files = ["pre-migrate-20261001T000000Z-abc.dump", "notes.txt", "other.dump.partial", "x.partial"].map(
      (name) => ({ name, mtimeMs: old })
    );
    expect(stalePartialDumps(files, now)).toEqual([]);
  });
});
