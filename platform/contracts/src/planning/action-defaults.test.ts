import { describe, expect, it } from "vitest";
import {
  ACTION_DEFAULTS,
  ASSUMABLE_ACTION_FIELDS,
  assumedFieldsAfterUpdate,
  isAssumableActionField,
  normalizeAssumedFields,
  withActionDefaults
} from "./action-defaults.js";
import { saveActionCommandSchema } from "./commands.js";

describe("withActionDefaults", () => {
  it("fills every starting value for a bare action and lists the estimate and judgement fields as assumed", () => {
    const { entity, assumed } = withActionDefaults({ id: "a1", projectId: "p1", title: "Call the bank" });
    expect(entity).toEqual({
      id: "a1",
      projectId: "p1",
      title: "Call the bank",
      status: "planned",
      optimisticMinutes: 60,
      expectedMinutes: 60,
      pessimisticMinutes: 60,
      remainingMinutes: 60,
      splittable: true,
      setupMinutes: 0,
      energy: "medium",
      minimumSessionMinutes: 15,
      maximumSessionMinutes: 60,
      importance: 3,
      consequence: 3,
      contexts: [],
      dependencyIds: []
    });
    expect(assumed).toEqual([...ASSUMABLE_ACTION_FIELDS]);
  });

  it("lists only the fields it filled, in the canonical order, whatever order the caller gave its own", () => {
    const { entity, assumed } = withActionDefaults({
      title: "Write",
      importance: 5,
      expectedMinutes: 90,
      energy: "high"
    });
    expect(entity).toMatchObject({
      importance: 5,
      expectedMinutes: 90,
      energy: "high",
      optimisticMinutes: 90,
      pessimisticMinutes: 90,
      remainingMinutes: 90
    });
    expect(assumed).toEqual([
      "optimisticMinutes",
      "pessimisticMinutes",
      "remainingMinutes",
      "minimumSessionMinutes",
      "maximumSessionMinutes",
      "consequence",
      "splittable",
      "setupMinutes"
    ]);
  });

  it("never lists the structural fields, whether given or filled", () => {
    const filled = withActionDefaults({});
    expect(filled.entity).toMatchObject({ status: "planned", contexts: [], dependencyIds: [] });
    expect(filled.assumed).not.toContain("status");
    expect(filled.assumed).not.toContain("contexts");
    expect(filled.assumed).not.toContain("dependencyIds");
    const given = withActionDefaults({ status: "doing", contexts: ["home"], dependencyIds: ["x"] });
    expect(given.entity).toMatchObject({ status: "doing", contexts: ["home"], dependencyIds: ["x"] });
  });

  it("treats a value of false or 0 as given, and an explicit undefined as missing", () => {
    const { entity, assumed } = withActionDefaults({ splittable: false, setupMinutes: 0, expectedMinutes: undefined });
    expect(entity).toMatchObject({ splittable: false, setupMinutes: 0, expectedMinutes: 60 });
    expect(assumed).toContain("expectedMinutes");
    expect(assumed).not.toContain("splittable");
    expect(assumed).not.toContain("setupMinutes");
  });

  it("leaves a null for validation to refuse rather than filling over it", () => {
    const { entity, assumed } = withActionDefaults({ expectedMinutes: null });
    expect(entity.expectedMinutes).toBeNull();
    expect(assumed).not.toContain("expectedMinutes");
  });

  it("does not change its input or share the default arrays between calls", () => {
    const given = { title: "x" };
    const first = withActionDefaults(given);
    expect(given).toEqual({ title: "x" });
    (first.entity.contexts as string[]).push("home");
    expect(withActionDefaults({}).entity.contexts).toEqual([]);
    expect(ACTION_DEFAULTS.contexts).toEqual([]);
  });

  it("produces an action the save schema accepts, with the assumed list", () => {
    const { entity, assumed } = withActionDefaults({ id: "a1", projectId: "p1", title: "Call the bank" });
    const parsed = saveActionCommandSchema.safeParse({
      expectedVersion: null,
      action: { ...entity, assumedFields: assumed }
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.action.assumedFields).toEqual(assumed);
  });
});

describe("withActionDefaults: working out what is missing from what was given", () => {
  /** The checks `saveActionCommandSchema` makes on an action, with the structural fields filled in. */
  const saves = (entity: Record<string, unknown>) =>
    saveActionCommandSchema.safeParse({
      expectedVersion: null,
      action: { id: "a1", projectId: "p1", title: "x", ...entity }
    });
  const minutes = (entity: Record<string, unknown>) => ({
    optimistic: entity.optimisticMinutes,
    expected: entity.expectedMinutes,
    pessimistic: entity.pessimisticMinutes,
    remaining: entity.remainingMinutes
  });

  it("gives exactly the defaults when nothing was given, as three equal figures with no range", () => {
    const { entity } = withActionDefaults({});
    expect(minutes(entity)).toEqual({ optimistic: 60, expected: 60, pessimistic: 60, remaining: 60 });
    expect(entity).toMatchObject({
      optimisticMinutes: ACTION_DEFAULTS.optimisticMinutes,
      expectedMinutes: ACTION_DEFAULTS.expectedMinutes,
      pessimisticMinutes: ACTION_DEFAULTS.pessimisticMinutes,
      remainingMinutes: ACTION_DEFAULTS.remainingMinutes,
      minimumSessionMinutes: ACTION_DEFAULTS.minimumSessionMinutes,
      maximumSessionMinutes: ACTION_DEFAULTS.maximumSessionMinutes
    });
  });

  it.each([
    [15, { optimistic: 15, expected: 15, pessimistic: 15, remaining: 15 }],
    [240, { optimistic: 240, expected: 240, pessimistic: 240, remaining: 240 }],
    [1, { optimistic: 1, expected: 1, pessimistic: 1, remaining: 1 }]
  ])("invents no spread around a lone expected of %i, and lists the rest as assumed", (expected, want) => {
    const { entity, assumed } = withActionDefaults({ expectedMinutes: expected });
    expect(minutes(entity)).toEqual(want);
    expect(assumed).toEqual(expect.arrayContaining(["optimisticMinutes", "pessimisticMinutes", "remainingMinutes"]));
    expect(assumed).not.toContain("expectedMinutes");
    expect(saves(entity).success).toBe(true);
  });

  it("treats a lone remaining as the expected effort too", () => {
    const { entity, assumed } = withActionDefaults({ remainingMinutes: 45 });
    expect(minutes(entity)).toEqual({ optimistic: 45, expected: 45, pessimistic: 45, remaining: 45 });
    expect(assumed).toContain("expectedMinutes");
    expect(assumed).not.toContain("remainingMinutes");
    expect(saves(entity).success).toBe(true);
  });

  it("keeps a zero remaining and works the rest out from the default expected", () => {
    const { entity } = withActionDefaults({ remainingMinutes: 0 });
    expect(minutes(entity)).toEqual({ optimistic: 60, expected: 60, pessimistic: 60, remaining: 0 });
    expect(saves(entity).success).toBe(true);
  });

  it("brings the expected effort down to a pessimistic that is below the default", () => {
    const { entity, assumed } = withActionDefaults({ pessimisticMinutes: 20 });
    expect(minutes(entity)).toEqual({ optimistic: 20, expected: 20, pessimistic: 20, remaining: 20 });
    expect(assumed).toEqual(expect.arrayContaining(["optimisticMinutes", "expectedMinutes", "remainingMinutes"]));
    expect(assumed).not.toContain("pessimisticMinutes");
    expect(saves(entity).success).toBe(true);
  });

  it("brings the expected effort up to an optimistic that is above the default", () => {
    const { entity } = withActionDefaults({ optimisticMinutes: 100 });
    expect(minutes(entity)).toEqual({ optimistic: 100, expected: 100, pessimistic: 100, remaining: 100 });
    expect(saves(entity).success).toBe(true);
  });

  it("keeps the default expected between an optimistic and pessimistic that are given", () => {
    const { entity } = withActionDefaults({ optimisticMinutes: 20, pessimisticMinutes: 200 });
    expect(minutes(entity)).toEqual({ optimistic: 20, expected: 60, pessimistic: 200, remaining: 60 });
    expect(saves(entity).success).toBe(true);
  });

  it("fills the missing estimates around a given expected and pessimistic", () => {
    const { entity } = withActionDefaults({ expectedMinutes: 100, pessimisticMinutes: 120 });
    expect(minutes(entity)).toEqual({ optimistic: 100, expected: 100, pessimistic: 120, remaining: 100 });
    expect(saves(entity).success).toBe(true);
  });

  it("raises a derived pessimistic to a remaining that is given above it", () => {
    const { entity } = withActionDefaults({ expectedMinutes: 60, remainingMinutes: 100 });
    expect(minutes(entity)).toEqual({ optimistic: 60, expected: 60, pessimistic: 100, remaining: 100 });
    expect(saves(entity).success).toBe(true);
  });

  it("keeps the session range ordered around whichever end was given", () => {
    const low = withActionDefaults({ maximumSessionMinutes: 10 }).entity;
    expect([low.minimumSessionMinutes, low.maximumSessionMinutes]).toEqual([10, 10]);
    const high = withActionDefaults({ minimumSessionMinutes: 90 }).entity;
    expect([high.minimumSessionMinutes, high.maximumSessionMinutes]).toEqual([90, 90]);
    const both = withActionDefaults({ minimumSessionMinutes: 20, maximumSessionMinutes: 45 }).entity;
    expect([both.minimumSessionMinutes, both.maximumSessionMinutes]).toEqual([20, 45]);
    expect(saves(low).success && saves(high).success && saves(both).success).toBe(true);
  });

  it("never changes a value the caller gave, and does not try to repair a conflict between two of them", () => {
    const { entity } = withActionDefaults({ expectedMinutes: 50, pessimisticMinutes: 40 });
    expect(minutes(entity)).toMatchObject({ expected: 50, pessimistic: 40 });
    expect(saves(entity).success).toBe(false);
  });

  it("ignores a value that is not a number when working out the rest", () => {
    const { entity } = withActionDefaults({ expectedMinutes: "soon", remainingMinutes: null });
    expect(entity.expectedMinutes).toBe("soon");
    expect(entity.remainingMinutes).toBeNull();
    expect(entity.optimisticMinutes).toBe(60);
  });

  it("states no range of its own, whatever figure of the estimate is given or none, so the project's uncertainty pads it", () => {
    for (const given of [
      {},
      { remainingMinutes: 0 },
      { expectedMinutes: 45 },
      { remainingMinutes: 45 },
      { pessimisticMinutes: 45 }
    ]) {
      const { optimisticMinutes, expectedMinutes, pessimisticMinutes } = withActionDefaults(given).entity;
      expect([optimisticMinutes, pessimisticMinutes]).toEqual([expectedMinutes, expectedMinutes]);
    }
  });
});

describe("assumedFieldsAfterUpdate", () => {
  it("keeps every stored field the caller did not name", () => {
    expect(assumedFieldsAfterUpdate(["expectedMinutes", "energy"], ["title"])).toEqual(["expectedMinutes", "energy"]);
  });

  it("drops a field the caller named, even to the value it already had", () => {
    expect(assumedFieldsAfterUpdate(["expectedMinutes", "energy"], ["expectedMinutes"])).toEqual(["energy"]);
    expect(assumedFieldsAfterUpdate(["importance"], new Set(["importance", "title"]))).toEqual([]);
  });

  it("treats nothing stored as nothing assumed", () => {
    expect(assumedFieldsAfterUpdate(undefined, ["energy"])).toEqual([]);
    expect(assumedFieldsAfterUpdate(null, [])).toEqual([]);
  });
});

describe("normalizeAssumedFields", () => {
  it("keeps the assumable names once each in canonical order and drops the rest", () => {
    expect(normalizeAssumedFields(["energy", "status", "expectedMinutes", "energy", 7, "contexts"])).toEqual([
      "expectedMinutes",
      "energy"
    ]);
    expect(normalizeAssumedFields(undefined)).toEqual([]);
  });

  it("recognises exactly the assumable names", () => {
    expect(isAssumableActionField("setupMinutes")).toBe(true);
    expect(isAssumableActionField("status")).toBe(false);
    expect(isAssumableActionField("title")).toBe(false);
  });
});

describe("assumedFields on the action save", () => {
  const action = {
    id: "a1",
    projectId: "p1",
    title: "Run",
    status: "planned",
    ...Object.fromEntries(Object.entries(ACTION_DEFAULTS).filter(([name]) => name !== "status"))
  };

  it("is optional, so a save from before it existed still parses", () => {
    const parsed = saveActionCommandSchema.safeParse({ expectedVersion: null, action });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.action.assumedFields).toBeUndefined();
  });

  it("takes an empty list and refuses a name that cannot be assumed", () => {
    expect(
      saveActionCommandSchema.safeParse({ expectedVersion: null, action: { ...action, assumedFields: [] } }).success
    ).toBe(true);
    expect(
      saveActionCommandSchema.safeParse({ expectedVersion: null, action: { ...action, assumedFields: ["status"] } })
        .success
    ).toBe(false);
  });
});
