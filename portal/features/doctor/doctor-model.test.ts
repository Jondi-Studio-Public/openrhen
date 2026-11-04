import { describe, expect, it } from "vitest";
import type { DoctorItem, DoctorReport } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import {
  areasPresent,
  attentionCount,
  groupByTier,
  handleLink,
  parseDoctorReport,
  sinceText,
  summaryLine
} from "./doctor-model";

function item(overrides: Partial<DoctorItem> & Pick<DoctorItem, "id">): DoctorItem {
  return {
    check: "stale_wake",
    tier: "tidy",
    area: "plan",
    title: "T",
    why: "W",
    handles: [],
    fix: { who: "person", question: "Q?" },
    ...overrides
  };
}

function report(items: DoctorItem[], healthy = items.length === 0): DoctorReport {
  const counts = { blocking: 0, degrading: 0, tidy: 0 };
  for (const next of items) counts[next.tier] += 1;
  return { generatedAt: "2026-10-29T00:00:00.000Z", healthy, counts, byArea: {}, items, notChecked: [] };
}

describe("summaryLine", () => {
  it("says Healthy with nothing, and otherwise counts only the tiers that have items", () => {
    expect(summaryLine(report([]))).toBe("Healthy");
    const items = [
      item({ id: "a", tier: "blocking" }),
      item({ id: "b", tier: "tidy" }),
      item({ id: "c", tier: "tidy" })
    ];
    expect(summaryLine(report(items))).toBe("1 blocking, 2 tidy");
  });
});

describe("attentionCount", () => {
  it("is blocking plus degrading, never tidy", () => {
    expect(attentionCount({ counts: { blocking: 2, degrading: 3, tidy: 9 } })).toBe(5);
  });
});

describe("groupByTier", () => {
  const items = [
    item({ id: "a", tier: "blocking", area: "facts" }),
    item({ id: "b", tier: "tidy", area: "plan" }),
    item({ id: "c", tier: "tidy", area: "facts" })
  ];
  it("keeps tier order and drops empty tiers", () => {
    expect(groupByTier(items, null).map((group) => [group.tier, group.items.length])).toEqual([
      ["blocking", 1],
      ["tidy", 2]
    ]);
  });
  it("filters by area", () => {
    expect(groupByTier(items, "plan").map((group) => group.items.map((next) => next.id))).toEqual([["b"]]);
    expect(groupByTier(items, "routines")).toEqual([]);
  });
  it("lists the areas that appear", () => {
    expect(areasPresent(items)).toEqual(["facts", "plan"]);
  });
});

describe("sinceText", () => {
  const now = new Date("2026-10-29T12:00:00.000Z");
  it("gives hours then days, and nothing without a date", () => {
    expect(sinceText("2026-10-29T06:00:00.000Z", now)).toBe("for 6 hours");
    expect(sinceText("2026-10-24T12:00:00.000Z", now)).toBe("for 5 days");
    expect(sinceText(undefined, now)).toBeNull();
    expect(sinceText("nonsense", now)).toBeNull();
  });
});

describe("parseDoctorReport", () => {
  it("accepts a report and refuses anything else", () => {
    expect(parseDoctorReport(report([]))?.healthy).toBe(true);
    expect(parseDoctorReport({})).toBeNull();
    expect(parseDoctorReport(null)).toBeNull();
  });
});

describe("handleLink", () => {
  const state = createSeedState(new Date("2026-10-29T00:00:00.000Z"));
  const plan = { projects: state.projects, outcomes: state.outcomes, areas: state.areas };
  it("links commitments, projects and outcomes, and nothing else", () => {
    const project = state.projects[0]!;
    expect(handleLink("commitment:abc", plan)?.href).toBe("/commitments/abc");
    expect(handleLink(`project:${project.id}`, plan)?.href).toContain(`#project-${project.id}`);
    expect(handleLink("project:missing", plan)).toBeNull();
    expect(handleLink("action:abc", plan)).toBeNull();
    expect(handleLink("import_batch:abc", plan)).toBeNull();
    expect(handleLink("nocolon", plan)).toBeNull();
  });
});
