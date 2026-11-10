import { describe, expect, it } from "vitest";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import { deadlineItems, readDeadlineOutlook } from "./deadline-items";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const generatedAt = "2026-11-10T12:00:00.000Z";
const row = (n: number, verdict: string, over: Record<string, unknown> = {}) => ({
  projectId: uuid(n),
  title: `Project ${n}`,
  verdict,
  deadlineAt: "2026-11-12T09:00:00.000Z",
  slackMinutes: -45,
  suggestion: "Start by 3:00 PM or this deadline becomes unreachable.",
  ...over
});

describe("deadlineItems", () => {
  it("builds one item per behind or overdue project and skips tight, ok and none", () => {
    const items = deadlineItems(
      { projects: [row(1, "behind"), row(2, "overdue"), row(3, "tight"), row(4, "ok"), row(5, "none")], outcomes: [] },
      { held: undefined, generatedAt }
    );
    expect(items.map((item) => item.id)).toEqual([`deadline_at_risk:${uuid(1)}`, `deadline_at_risk:${uuid(2)}`]);
  });

  it("ignores a repeated project, a malformed row and a project id that is not a uuid", () => {
    const items = deadlineItems(
      {
        projects: [
          row(1, "behind"),
          row(1, "overdue"),
          null,
          "x",
          { verdict: "behind" },
          row(2, "behind", { projectId: "bad" })
        ]
      },
      { held: undefined, generatedAt }
    );
    expect(items.map((item) => item.id)).toEqual([`deadline_at_risk:${uuid(1)}`]);
  });

  it("returns nothing for an absent or unreadable outlook", () => {
    for (const value of [null, undefined, 5, "x", [], {}, { projects: {} }])
      expect(deadlineItems(value, { held: undefined, generatedAt })).toEqual([]);
  });
});

describe("readDeadlineOutlook", () => {
  const fake = (rows: unknown[]) => (async () => rows) as unknown as PoolSql;
  it("returns the stored field of the latest run, or null when there is no run or no field", async () => {
    expect(await readDeadlineOutlook(fake([{ outlook: { projects: [] } }]), "u")).toEqual({ projects: [] });
    expect(await readDeadlineOutlook(fake([{ outlook: null }]), "u")).toBeNull();
    expect(await readDeadlineOutlook(fake([]), "u")).toBeNull();
  });
});
