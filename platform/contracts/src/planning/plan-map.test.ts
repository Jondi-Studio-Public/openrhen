import { describe, expect, it } from "vitest";
import {
  PLAN_ITEM_TYPES,
  PLAN_LINK_KINDS,
  ON_OFF_ONLY_ADDONS,
  PLAN_MAP_ADDONS,
  SWITCHABLE_ADDONS,
  canPropose,
  defaultSwitchMode,
  effectiveMode,
  isExpirable,
  isOwnerProposer,
  planMapBulkConfirmSchema,
  planMapFindingActionSchema,
  planMapLinkActionSchema,
  planMapSwitchInputSchema,
  planLinkProposerSchema,
  validateLink,
  validateLinkEnds,
  type PlanItemType,
  type PlanLinkKind
} from "./plan-map.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe("validateLinkEnds", () => {
  it("lets any item be about a subject, and nothing else be about", () => {
    for (const type of PLAN_ITEM_TYPES.filter((candidate) => candidate !== "subject")) {
      expect(validateLinkEnds("about", type, "subject").ok).toBe(true);
    }
    expect(validateLinkEnds("about", "subject", "subject").ok).toBe(false);
    expect(validateLinkEnds("about", "action", "project").ok).toBe(false);
  });

  it("takes involves to a contact and references to a source", () => {
    expect(validateLinkEnds("involves", "project", "contact").ok).toBe(true);
    expect(validateLinkEnds("involves", "project", "source").ok).toBe(false);
    expect(validateLinkEnds("references", "deliverable", "source").ok).toBe(true);
    expect(validateLinkEnds("references", "deliverable", "contact").ok).toBe(false);
  });

  it("makes occurrence_of commitment to project and before project to project", () => {
    expect(validateLinkEnds("occurrence_of", "commitment", "project").ok).toBe(true);
    expect(validateLinkEnds("occurrence_of", "action", "project").ok).toBe(false);
    expect(validateLinkEnds("before", "project", "project").ok).toBe(true);
    expect(validateLinkEnds("before", "action", "action").ok).toBe(false);
  });

  it("lets prepares and counts_toward join work items and subjects", () => {
    expect(validateLinkEnds("prepares", "action", "commitment").ok).toBe(true);
    expect(validateLinkEnds("prepares", "action", "subject").ok).toBe(true);
    expect(validateLinkEnds("prepares", "contact", "action").ok).toBe(false);
    expect(validateLinkEnds("counts_toward", "action", "project").ok).toBe(true);
    expect(validateLinkEnds("counts_toward", "deliverable", "subject").ok).toBe(true);
    expect(validateLinkEnds("counts_toward", "source", "project").ok).toBe(false);
  });

  it("explains a rejection", () => {
    const result = validateLinkEnds("before", "action", "project");
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("before") });
  });

  it("accepts at least one pair for every kind", () => {
    for (const kind of PLAN_LINK_KINDS as readonly PlanLinkKind[]) {
      const some = PLAN_ITEM_TYPES.some((from: PlanItemType) =>
        PLAN_ITEM_TYPES.some((to: PlanItemType) => validateLinkEnds(kind, from, to).ok)
      );
      expect(some).toBe(true);
    }
  });
});

describe("validateLink", () => {
  it("rejects a self link and accepts a distinct pair", () => {
    expect(validateLink({ kind: "prepares", fromType: "action", fromId: "a", toType: "action", toId: "a" }).ok).toBe(
      false
    );
    expect(validateLink({ kind: "prepares", fromType: "action", fromId: "a", toType: "action", toId: "b" }).ok).toBe(
      true
    );
  });
});

describe("isExpirable", () => {
  it("expires only a suggestion older than 30 days", () => {
    expect(isExpirable({ status: "suggested", createdAt: daysAgo(31) }, NOW)).toBe(true);
    expect(isExpirable({ status: "suggested", createdAt: daysAgo(30) }, NOW)).toBe(false);
    expect(isExpirable({ status: "suggested", createdAt: daysAgo(2) }, NOW)).toBe(false);
    expect(isExpirable({ status: "confirmed", createdAt: daysAgo(90) }, NOW)).toBe(false);
    expect(isExpirable({ status: "rejected", createdAt: daysAgo(90) }, NOW)).toBe(false);
  });
});

describe("canPropose", () => {
  const pair = { kind: "about", fromType: "action", fromId: "a1", toType: "subject", toId: "maths" } as const;
  const existing = (status: "suggested" | "confirmed" | "rejected" | "expired") => [{ ...pair, status }];

  it("proposes a pair nobody has seen", () => {
    expect(canPropose([], pair, false)).toBe(true);
    expect(canPropose([{ ...pair, toId: "meals", status: "rejected" }], pair, false)).toBe(true);
  });

  it("never proposes a rejected pair, even with new evidence", () => {
    expect(canPropose(existing("rejected"), pair, false)).toBe(false);
    expect(canPropose(existing("rejected"), pair, true)).toBe(false);
  });

  it("proposes an expired pair only with new evidence", () => {
    expect(canPropose(existing("expired"), pair, false)).toBe(false);
    expect(canPropose(existing("expired"), pair, true)).toBe(true);
  });

  it("does not propose a pair already suggested or confirmed", () => {
    expect(canPropose(existing("suggested"), pair, true)).toBe(false);
    expect(canPropose(existing("confirmed"), pair, true)).toBe(false);
  });
});

describe("defaults and proposers", () => {
  it("defaults every switch to off", () => {
    expect(defaultSwitchMode()).toBe("off");
  });

  it("accepts the documented proposers only", () => {
    for (const ok of ["owner", "tga", "reviewer", "rule:unit-code", "model:haiku"]) {
      expect(planLinkProposerSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ["", "rule:", "someone", "model", "person"]) {
      expect(planLinkProposerSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("reads owner as hand-made, and nothing else", () => {
    expect(isOwnerProposer("owner")).toBe(true);
    expect(isOwnerProposer("person")).toBe(false);
    expect(isOwnerProposer("tga")).toBe(false);
    expect(isOwnerProposer("rule:x")).toBe(false);
  });
});

describe("plan map request schemas", () => {
  it("accepts only the named link and finding actions", () => {
    expect(planMapLinkActionSchema.safeParse({ action: "remove" }).success).toBe(true);
    expect(planMapLinkActionSchema.safeParse({ action: "reopen" }).success).toBe(true);
    expect(planMapLinkActionSchema.safeParse({ action: "accept" }).success).toBe(false);
    expect(planMapFindingActionSchema.safeParse({ action: "dismiss" }).success).toBe(true);
    expect(planMapFindingActionSchema.safeParse({ action: "reopen" }).success).toBe(true);
    expect(planMapFindingActionSchema.safeParse({ action: "confirm" }).success).toBe(false);
  });

  it("validates bulk confirm and switch input", () => {
    expect(planMapBulkConfirmSchema.safeParse({ proposer: "rule:calendar", kind: "about" }).success).toBe(true);
    expect(planMapBulkConfirmSchema.safeParse({ proposer: "nobody", kind: "about" }).success).toBe(false);
    expect(planMapSwitchInputSchema.safeParse({ addon: "nudge", mode: "shadow" }).success).toBe(true);
    expect(planMapSwitchInputSchema.safeParse({ addon: "nudge", mode: "maybe" }).success).toBe(false);
    expect(planMapSwitchInputSchema.safeParse({ addon: "navigator", mode: "on" }).success).toBe(false);
    expect(planMapSwitchInputSchema.safeParse({ addon: "backfill", mode: "on" }).success).toBe(false);
  });

  it("refuses to set shadow on an off/on-only add-on", () => {
    for (const addon of ON_OFF_ONLY_ADDONS) {
      expect(planMapSwitchInputSchema.safeParse({ addon, mode: "shadow" }).success).toBe(false);
      expect(planMapSwitchInputSchema.safeParse({ addon, mode: "on" }).success).toBe(true);
    }
  });
});

describe("effectiveMode", () => {
  it("reads a stored shadow as on for jev_subjects and as off for email_needs_reply", () => {
    expect(effectiveMode("jev_subjects", "shadow")).toBe("on");
    expect(effectiveMode("email_needs_reply", "shadow")).toBe("off");
  });

  it("keeps off and on, keeps shadow where it is offered, and reads absent or unknown as off, for the switchable add-ons", () => {
    for (const addon of SWITCHABLE_ADDONS) {
      expect(effectiveMode(addon, "off")).toBe("off");
      expect(effectiveMode(addon, "on")).toBe("on");
      expect(effectiveMode(addon, null)).toBe("off");
      expect(effectiveMode(addon, undefined)).toBe("off");
      expect(effectiveMode(addon, "bogus")).toBe("off");
    }
    for (const addon of ["executor", "nudge", "capture_placement"] as const)
      expect(effectiveMode(addon, "shadow")).toBe("shadow");
  });

  it("reads every other add-on as on whatever is stored", () => {
    const alwaysOn = PLAN_MAP_ADDONS.filter((addon) => !(SWITCHABLE_ADDONS as readonly string[]).includes(addon));
    expect(alwaysOn.sort()).toEqual([
      "backfill",
      "catch_up",
      "email_drafts",
      "explorer",
      "health_checks",
      "proposers",
      "reviewer"
    ]);
    for (const addon of alwaysOn)
      for (const stored of ["off", "shadow", "on", null, undefined, "bogus"])
        expect(effectiveMode(addon, stored)).toBe("on");
  });

  it("has no navigator add-on", () => {
    expect((PLAN_MAP_ADDONS as readonly string[]).includes("navigator")).toBe(false);
  });
});
