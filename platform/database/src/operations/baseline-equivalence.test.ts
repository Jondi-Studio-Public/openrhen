import { describe, expect, it } from "vitest";
import {
  classifyLegacy,
  decideAdoption,
  knownLedgerRows,
  unknownLedgerTimestamp,
  type BaselineFile,
  type LegacyMigration
} from "./baseline-equivalence.js";

const legacy: LegacyMigration[] = [0, 1, 2, 3].map((idx) => ({
  idx,
  when: 100 + idx * 10,
  hashes: [`h${idx}`, `h${idx}-lf`]
}));
const later: LegacyMigration[] = [{ idx: 4, when: 200, hashes: ["h4"] }];
const row = (hash: string, createdAt: number) => ({ hash, createdAt });
const allRows = legacy.map((entry) => row(entry.hashes[0]!, entry.when));
const baseline: BaselineFile = { version: 1, baselineIdx: 3, legacy, laterLegacy: later };
// The baseline entry of the OpenRhen journal: it shares the last legacy `when`, with a hash of its own.
const baselineEntry = { tag: "0003_baseline", when: 130, hashes: ["baseline-hash"] };

describe("classifyLegacy", () => {
  it("is none for an empty ledger and for unrelated rows", () => {
    expect(classifyLegacy(legacy, [])).toEqual({ state: "none", matched: 0, total: 4, firstMissingIdx: 0 });
    expect(classifyLegacy(legacy, [row("other", 999)]).state).toBe("none");
  });

  it("is complete when every entry has a row", () => {
    expect(classifyLegacy(legacy, allRows)).toEqual({ state: "complete", matched: 4, total: 4, firstMissingIdx: null });
  });

  it("is partial, naming the first missing idx, when rows stop early or have a hole", () => {
    expect(classifyLegacy(legacy, allRows.slice(0, 2))).toEqual({
      state: "partial",
      matched: 2,
      total: 4,
      firstMissingIdx: 2
    });
    expect(classifyLegacy(legacy, [allRows[0]!, allRows[2]!, allRows[3]!])).toMatchObject({
      state: "partial",
      firstMissingIdx: 1
    });
  });

  it("matches the LF form of a file's hash", () => {
    const rows = allRows.map((r, i) => (i === 1 ? row("h1-lf", r.createdAt) : r));
    expect(classifyLegacy(legacy, rows).state).toBe("complete");
  });

  it("matches a file edited after it was applied by its created_at", () => {
    const rows = allRows.map((r, i) => (i === 2 ? row("old-contents", r.createdAt) : r));
    expect(classifyLegacy(legacy, rows).state).toBe("complete");
  });

  it("lets a second row for one file not stand in for another entry (0056 applied at two stamps)", () => {
    // Entry 1 has no row of its own; the extra h0 row at entry 1's `when` must not count as entry 1.
    const rows = [allRows[0]!, row("h0", legacy[1]!.when), allRows[2]!, allRows[3]!];
    expect(classifyLegacy(legacy, rows)).toMatchObject({ state: "partial", firstMissingIdx: 1 });
    // And with entry 1 present too, the duplicate is just spare.
    expect(classifyLegacy(legacy, [...allRows, row("h0", 5_000)]).state).toBe("complete");
  });
});

describe("knownLedgerRows and unknownLedgerTimestamp", () => {
  it("knows legacy and later legacy rows by hash or by created_at, and nothing else", () => {
    const rows = [...allRows, row("h4", 200), row("edited", 200), row("native", 300)];
    expect(knownLedgerRows(legacy, later, rows).map((r) => r.hash)).toEqual(["h0", "h1", "h2", "h3", "h4", "edited"]);
    expect(unknownLedgerTimestamp(baseline, rows)).toBe(300);
  });

  it("ignores a ledger that holds only known rows, however new, and every row without a baseline", () => {
    expect(unknownLedgerTimestamp(baseline, [...allRows, row("h4", 200)])).toBe(0);
    expect(unknownLedgerTimestamp(null, [row("x", 7)])).toBe(7);
  });
});

describe("decideAdoption", () => {
  it("runs the baseline on an empty or unrelated ledger", () => {
    expect(decideAdoption(baseline, baselineEntry, []).action).toBe("fresh");
    expect(decideAdoption(baseline, baselineEntry, [row("x", 1)]).action).toBe("fresh");
  });

  it("adopts a complete history, with the baseline's own hash and when", () => {
    expect(decideAdoption(baseline, baselineEntry, allRows)).toMatchObject({
      action: "adopt",
      hash: "baseline-hash",
      createdAt: 130,
      baselineTag: "0003_baseline"
    });
  });

  it("does nothing when the baseline's own row is present, even though it shares the last legacy `when`", () => {
    expect(decideAdoption(baseline, baselineEntry, [row("baseline-hash", 130)]).action).toBe("already");
    expect(decideAdoption(baseline, baselineEntry, [...allRows, row("baseline-hash", 130)]).action).toBe("already");
  });

  it("refuses a partial history with an actionable message that names no tags", () => {
    const decision = decideAdoption(baseline, baselineEntry, allRows.slice(0, 2));
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") return;
    expect(decision.message).toContain("2 of 4");
    expect(decision.message).toContain("MIGRATE_ON_DEPLOY=skip");
    expect(decision.message).not.toMatch(/\d{4}_/);
  });
});
