import { describe, expect, it } from "vitest";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { DRIFT_REPORT_MAX_ROWS, readDriftReport } from "./drift-report";

/** A tagged-template stand-in that answers the check-in query first and the session query second, and keeps what was bound. */
function fakeSql(checkIns: unknown[], sessions: unknown[]) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const answers = [checkIns, sessions];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    queries.push({ text: strings.join("?"), values });
    return Promise.resolve(answers[queries.length - 1] ?? []);
  }) as unknown as Sql;
  return { sql, queries };
}

const t = (minutes: number) => new Date(Date.UTC(2026, 0, 5, 9, 0, 0) + minutes * 60_000);
const sessionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "s1",
  status: "completed",
  started_at: t(0),
  started_recorded_at: null,
  ended_at: t(30),
  ended_recorded_at: null,
  plan_sanction: null,
  created_at: t(0),
  ...overrides
});

describe("readDriftReport", () => {
  it("maps rows to episodes with counts and ISO times", async () => {
    const { sql } = fakeSql(
      [{ id: "c1", status: "deviated", answered_at: t(200), answer_source: "sheet", answered_by: null }],
      [sessionRow()]
    );
    const report = await readDriftReport(sql, "user-1", { from: t(-60), to: t(300), now: t(301) });
    expect(report.generatedAt).toBe(t(301).toISOString());
    expect(report.counts).toMatchObject({ episodes: 2, pinned: 1 });
    expect(report.episodes.map((episode) => episode.id)).toEqual(["unsanctioned_session:s1", "deviated_checkin:c1"]);
    expect(report.episodes[0]?.occurredAt).toBe(t(0).toISOString());
    expect(report.truncated).toBe(false);
    expect(report.legacyBefore).toBeNull();
  });

  it("binds the user, a time window widened only by the collapse window, and a row limit", async () => {
    const { sql, queries } = fakeSql([], []);
    await readDriftReport(sql, "user-1", { from: t(0), to: t(100) });
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query.values[0]).toBe("user-1");
      expect(query.values).toContain(DRIFT_REPORT_MAX_ROWS);
      expect(query.text).toContain("LIMIT");
    }
    expect(queries[0]?.values[1]).toEqual(t(-10));
    expect(queries[0]?.values[2]).toEqual(t(110));
  });

  it("drops episodes outside the window and flags a table that hit the row bound", async () => {
    const rows = Array.from({ length: DRIFT_REPORT_MAX_ROWS }, (_, index) =>
      sessionRow({ id: `s${index}`, planSanction: "directive", plan_sanction: "directive" })
    );
    const { sql } = fakeSql(
      [],
      [...rows, sessionRow({ id: "late", started_at: t(5000), ended_at: null })].slice(0, DRIFT_REPORT_MAX_ROWS)
    );
    const report = await readDriftReport(sql, "user-1", { from: t(-60), to: t(60) });
    expect(report.truncated).toBe(true);
    expect(report.episodes).toEqual([]);
  });

  it("passes the legacy cut to the detector", async () => {
    const { sql } = fakeSql([], [sessionRow({ created_at: t(-5000) })]);
    const report = await readDriftReport(sql, "user-1", { from: t(-60), to: t(60), legacyBefore: t(-1000) });
    expect(report.episodes).toEqual([]);
    expect(report.legacyBefore).toBe(t(-1000).toISOString());
  });
});
