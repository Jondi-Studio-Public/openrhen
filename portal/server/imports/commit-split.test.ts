import { describe, expect, it } from "vitest";
import type { ImportRecord } from "@openrhen/contracts";
import { deferWithBlockedTargets } from "./commit-split";

const record = (
  overrides: Partial<ImportRecord> & Pick<ImportRecord, "id" | "importKey" | "entityType">
): ImportRecord => ({
  operation: "create",
  expectedVersion: null,
  matchedEntityId: null,
  fields: {},
  relationships: {},
  errors: [],
  warnings: [],
  removed: false,
  sortOrder: 0,
  ...overrides
});

const project = record({ id: "p", importKey: "proj", entityType: "project", relationships: { outcomeKey: "out" } });
const blockedProject = { ...project, errors: ["title is required."], operation: "rejected" as const };
const action = record({
  id: "a",
  importKey: "act",
  entityType: "action",
  relationships: { projectKey: "proj" }
});
const dependency = record({
  id: "d",
  importKey: "dep",
  entityType: "dependency",
  relationships: { actionKey: "act", dependsOnActionKey: "other" }
});
const unrelated = record({ id: "u", importKey: "area", entityType: "area" });

describe("deferWithBlockedTargets", () => {
  it("holds back only the blockers when nothing depends on them", () => {
    const held = deferWithBlockedTargets([blockedProject, unrelated], [blockedProject], new Set());
    expect(held.map((item) => item.id)).toEqual(["p"]);
  });

  it("carries a ready record along when its target is a blocked record in this batch, and says why", () => {
    const held = deferWithBlockedTargets([blockedProject, action, unrelated], [blockedProject], new Set());
    expect(held.map((item) => item.id)).toEqual(["p", "a"]);
    expect(held[1]!.warnings).toEqual(["Moved with proj, which this record depends on and which was blocked."]);
    expect(held[1]!.errors).toEqual([]);
  });

  it("keeps carrying until nothing else is stranded", () => {
    const held = deferWithBlockedTargets([blockedProject, action, dependency, unrelated], [blockedProject], new Set());
    expect(held.map((item) => item.id)).toEqual(["p", "a", "d"]);
  });

  it("does not carry a record whose target already exists outside the batch", () => {
    const held = deferWithBlockedTargets([blockedProject, action], [blockedProject], new Set(["project:proj"]));
    expect(held.map((item) => item.id)).toEqual(["p"]);
  });

  it("ignores removed records and relationships that name no entity", () => {
    const removed = { ...action, id: "r", removed: true };
    const routine = record({
      id: "c",
      importKey: "commit",
      entityType: "fixed_commitment",
      relationships: { routinePresetId: "proj" }
    });
    const held = deferWithBlockedTargets([blockedProject, removed, routine], [blockedProject], new Set());
    expect(held.map((item) => item.id)).toEqual(["p"]);
  });

  it("returns the held records in batch order", () => {
    const held = deferWithBlockedTargets([action, unrelated, blockedProject], [blockedProject], new Set());
    expect(held.map((item) => item.id)).toEqual(["a", "p"]);
  });

  it("carries a record along when a field-carried relation (asField) targets a blocked record", () => {
    // location_key on a fixed_commitment is carried as a record field (`locationId`), not in
    // `relationships` — commitmentLocation in import-spec.ts sets `asField: true`. A commitment whose
    // location was rejected must move with it, exactly like a plain relationship target.
    const blockedContext = record({
      id: "ctx",
      importKey: "office",
      entityType: "condition_definition",
      errors: ["kind is required."],
      operation: "rejected" as const
    });
    const commitment = record({
      id: "c",
      importKey: "standup",
      entityType: "fixed_commitment",
      fields: {
        locationId: { value: "office", basis: "explicit", confidence: "high", evidence: [], needsReview: false }
      }
    });
    const held = deferWithBlockedTargets([blockedContext, commitment, unrelated], [blockedContext], new Set());
    expect(held.map((item) => item.id)).toEqual(["ctx", "c"]);
    expect(held[1]!.warnings).toEqual(["Moved with office, which this record depends on and which was blocked."]);
    expect(held[1]!.errors).toEqual([]);
  });

  it("does not carry a record whose field-carried relation target already exists outside the batch", () => {
    const blockedContext = record({
      id: "ctx",
      importKey: "office",
      entityType: "condition_definition",
      errors: ["kind is required."],
      operation: "rejected" as const
    });
    const commitment = record({
      id: "c",
      importKey: "standup",
      entityType: "fixed_commitment",
      fields: {
        locationId: { value: "office", basis: "explicit", confidence: "high", evidence: [], needsReview: false }
      }
    });
    const held = deferWithBlockedTargets(
      [blockedContext, commitment],
      [blockedContext],
      new Set(["condition_definition:office"])
    );
    expect(held.map((item) => item.id)).toEqual(["ctx"]);
  });
});
