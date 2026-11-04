import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import {
  referenceCounts,
  referenceCrumbs,
  referenceRows,
  referenceScopeQuery,
  scopeCovers,
  scopeKey,
  scopeLabel
} from "./reference-pack-scopes";

const state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));

describe("referenceRows", () => {
  it("offers the plan and commitments at the root", () => {
    expect(referenceRows(state, { type: "root" }).map((row) => row.label)).toEqual([
      "Entire plan",
      "Fixed commitments"
    ]);
  });

  it("walks down from the plan through areas and outcomes to projects", () => {
    expect(referenceRows(state, { type: "plan" }).map((row) => row.label)).toEqual([
      "Study",
      "Home and administration"
    ]);
    const outcomes = referenceRows(state, { type: "area", id: "area-study" });
    expect(outcomes.map((row) => row.scope.id)).toEqual(["outcome-networking"]);
    expect(referenceRows(state, { type: "outcome", id: "outcome-networking" }).map((row) => row.scope.id)).toEqual([
      "networking-assignment"
    ]);
  });

  it("lists deliverables before actions inside a project and gives leaves no folder", () => {
    const rows = referenceRows(state, { type: "project", id: "networking-assignment" });
    expect(rows.map((row) => row.scope.type)).toEqual(["action"]);
    expect(rows[0]!.location).toBeUndefined();
  });
});

describe("referenceCrumbs", () => {
  it("shows only the root at the root", () => {
    expect(referenceCrumbs(state, { type: "root" }).map((crumb) => crumb.label)).toEqual(["Reference"]);
  });

  it("names the whole ancestry of a project", () => {
    expect(
      referenceCrumbs(state, { type: "project", id: "networking-assignment" }).map((crumb) => crumb.label)
    ).toEqual([
      "Reference",
      "Entire plan",
      "Study",
      "Complete Networking Assignment 2",
      "Submit Networking Assignment 2"
    ]);
  });
});

describe("scopeCovers", () => {
  it("treats the plan as covering every planning entity but not commitments", () => {
    expect(scopeCovers(state, { type: "plan" }, { type: "action", id: "room-floor" })).toBe(true);
    expect(scopeCovers(state, { type: "plan" }, { type: "fixed_commitment", id: "dinner" })).toBe(false);
    expect(scopeCovers(state, { type: "fixed_commitments" }, { type: "fixed_commitment", id: "dinner" })).toBe(true);
  });

  it("covers a descendant through its own branch only", () => {
    expect(
      scopeCovers(state, { type: "area", id: "area-study" }, { type: "action", id: "networking-section-one" })
    ).toBe(true);
    expect(scopeCovers(state, { type: "area", id: "area-study" }, { type: "action", id: "room-floor" })).toBe(false);
    expect(scopeCovers(state, { type: "project", id: "clean-room" }, { type: "action", id: "room-floor" })).toBe(true);
  });
});

describe("referenceCounts", () => {
  it("includes the ancestors a selected action needs to make sense", () => {
    expect(referenceCounts(state, [{ type: "action", id: "networking-section-one" }])).toMatchObject({
      areas: 1,
      outcomes: 1,
      projects: 1,
      actions: 1,
      commitments: 0
    });
  });

  it("expands a whole-plan selection to every planning record", () => {
    expect(referenceCounts(state, [{ type: "plan" }])).toMatchObject({
      areas: 2,
      outcomes: 2,
      projects: 2,
      actions: 2
    });
  });

  it("counts commitments only when they are chosen", () => {
    expect(referenceCounts(state, [{ type: "fixed_commitments" }])).toMatchObject({
      commitments: 1,
      areas: 0
    });
  });
});

describe("scope keys and labels", () => {
  it("keys a typed scope with and without an id", () => {
    expect(scopeKey({ type: "plan" })).toBe("plan:");
    expect(scopeKey({ type: "area", id: "area-study" })).toBe("area:area-study");
  });

  it("builds a query the reference-pack routes can read back", () => {
    expect(referenceScopeQuery([{ type: "plan" }, { type: "area", id: "area-study" }])).toBe(
      "scope=plan%3A&scope=area%3Aarea-study"
    );
  });

  it("labels a scope with the record's own name", () => {
    expect(scopeLabel(state, { type: "plan" })).toBe("Entire plan");
    expect(scopeLabel(state, { type: "area", id: "area-study" })).toBe("Study");
    expect(scopeLabel(state, { type: "action", id: "missing" })).toBe("Action");
  });
});
