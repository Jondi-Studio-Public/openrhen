import { describe, expect, it } from "vitest";
import { portalStateSchema } from "../portal/state-schema.js";
import { REMOVED_FIELD_NAMES } from "../removed-field-names.js";
import { z } from "zod";
import { ENTITY_FIELD_SCHEMAS, SAVE_ENTITY_KINDS, entityFieldNames, type SaveEntityKind } from "./entity-fields.js";

const at = "2026-10-28T09:00:00+10:00";
const later = "2026-10-28T10:00:00+10:00";

const minimal: Record<SaveEntityKind, Record<string, unknown>> = {
  area: { name: "Health", status: "active", sortOrder: 1 },
  outcome: { areaId: "a1", title: "Fit", definitionOfDone: "Run 5k", value: 3, status: "active" },
  project: { id: "p1", outcomeId: "o1", title: "Train", status: "active", uncertainty: "some", consequence: 3 },
  action: {
    id: "x1",
    projectId: "p1",
    title: "Run",
    status: "planned",
    optimisticMinutes: 30,
    expectedMinutes: 60,
    pessimisticMinutes: 90,
    remainingMinutes: 60,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    completedAt: at
  },
  commitment: {
    title: "Dentist",
    startsAt: at,
    endsAt: later,
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  },
  capture: { text: "Book the dentist", status: "pending" },
  deliverable: { projectId: "p1", title: "Report" },
  routine_step: {
    commitmentId: "c1",
    title: "Pack bag",
    sequence: 0,
    durationMinutes: 5,
    timingRule: "contiguous",
    energy: "low"
  },
  routine_preset: {
    name: "Gym",
    steps: [{ id: "s1", title: "Pack", durationMinutes: 5, timingRule: "contiguous", energy: "low" }]
  },
  sleep_plan: { id: "sp1", placementChoice: "early" },
  planning_focus: { kind: "weekly", periodStart: "2026-10-26", periodEnd: "2026-11-01", projectIds: ["p1"] },
  span: { title: "Holiday", startDate: "2026-12-20", endDate: "2026-12-31" },
  condition_definition: { id: "home", name: "Home", kind: "location", latitude: -33.8, longitude: 151.2 },
  settings: { timezone: "Australia/Sydney", sessionBreakMinutes: 15 },
  daily_plan: { localDate: "2026-10-28", desiredActionIds: ["x1"] },
  current_availability: { currentEnergy: "high", currentSituation: { locationId: "home" } },
  sleep_log_entry: { sleepAt: at, wakeAt: later },
  capture_review: { id: "cap1", proposalType: "action", draft: { title: "Run" } },
  deliverable_contract_review: { id: "prop1", decision: "ignore" },
  comparison: { groupId: "g1", rankedIds: ["a", "b", "c", "d"] }
};

describe("ENTITY_FIELD_SCHEMAS", () => {
  it("has a schema for every save entity kind", () => {
    expect(SAVE_ENTITY_KINDS).toHaveLength(20);
    expect(Object.keys(ENTITY_FIELD_SCHEMAS).sort()).toEqual([...SAVE_ENTITY_KINDS].sort());
    for (const kind of SAVE_ENTITY_KINDS) expect(entityFieldNames(kind).length).toBeGreaterThan(0);
  });

  it.each(SAVE_ENTITY_KINDS)("publishes a JSON Schema for %s", (kind) => {
    const json = z.toJSONSchema(ENTITY_FIELD_SCHEMAS[kind], { io: "input", unrepresentable: "any" });
    expect(json.type).toBe("object");
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([...entityFieldNames(kind)].sort());
  });

  it.each(SAVE_ENTITY_KINDS)("accepts a realistic minimal %s", (kind) => {
    const parsed = ENTITY_FIELD_SCHEMAS[kind].safeParse(minimal[kind]);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
  });

  it("lists names the portal reads and leaves read-only joined fields out", () => {
    expect(entityFieldNames("project")).not.toContain("area");
    expect(entityFieldNames("action")).toContain("completedAt");
    expect(entityFieldNames("action")).toContain("assumedFields");
    expect(entityFieldNames("settings")).toContain("leaveByLeadMinutes");
    expect(entityFieldNames("settings")).toEqual(
      expect.arrayContaining(["pulseUnknownToOffMinutes", "pulseFurtherPrompts", "pulseUnknownHardOffMinutes"])
    );
    expect(entityFieldNames("commitment")).toContain("checkInExtraMinutes");
    expect(entityFieldNames("span")).toContain("remove");
  });
});

describe("settings fields", () => {
  it("cover every stored setting, so a new one is not refused as unknown until someone adds it", () => {
    const stored = Object.keys(portalStateSchema.shape.settings.shape).filter((key) => key !== "version");
    const saveable = entityFieldNames("settings");
    expect(stored.filter((key) => !saveable.includes(key))).toEqual([]);
    // The one a save takes that the state reads elsewhere: a setup flag. (assertedConditions is no longer saveable: the engine ignores it; currentSituation is the situation.)
    expect(saveable.filter((key) => !stored.includes(key)).sort()).toEqual(["setupCompleted"]);
  });

  it("no longer lists the old calendar-sharing names", () => {
    for (const kind of SAVE_ENTITY_KINDS)
      for (const old of Object.keys(REMOVED_FIELD_NAMES))
        expect(entityFieldNames(kind), `${kind} ${old}`).not.toContain(old);
    expect(entityFieldNames("settings")).toEqual(
      expect.arrayContaining(["calendarShareEnabled", "sharePrimaryEvents"])
    );
    expect(entityFieldNames("commitment")).toContain("shareToCalendar");
  });
});
