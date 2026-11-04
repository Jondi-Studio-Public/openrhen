import { describe, expect, it } from "vitest";
import {
  IMPORT_ENTITY_ORDER,
  IMPORT_RELATION_TYPES,
  REQUIRED_IMPORT_FIELDS,
  REQUIRED_RELATIONSHIPS,
  importColumnChoices,
  importColumnFormat,
  importCsvEntities,
  importFieldKind,
  importFieldRelation,
  importFieldRelations,
  importFieldSpec,
  importSpecForType,
  importSpecs,
  importTemplateHeaders
} from "./import-spec";

describe("import spec", () => {
  it("names every import entity once, in a template and a sheet, and every entity is in the commit order", () => {
    const types = Object.values(importSpecs).map((spec) => spec.type);
    expect(new Set(types).size).toBe(types.length);
    expect(new Set(Object.values(importSpecs).map((spec) => spec.sheetName)).size).toBe(types.length);
    expect([...IMPORT_ENTITY_ORDER].sort()).toEqual([...types].sort());
    for (const entity of importCsvEntities)
      expect(importSpecForType(importSpecs[entity]!.type)).toBe(importSpecs[entity]);
  });

  it("gives every column a distinct header and field name, and one kind per field name across entities", () => {
    const kinds = new Map<string, string>();
    for (const spec of Object.values(importSpecs)) {
      const headers = [...spec.relations.map((r) => r.header), ...spec.columns.map((c) => c.header)];
      expect(new Set(headers).size).toBe(headers.length);
      const names = [...spec.relations.map((r) => r.name), ...spec.columns.map((c) => c.name)];
      expect(new Set(names).size).toBe(names.length);
      for (const column of spec.columns) {
        // The review screen reads a typed value by field name alone, so a name must mean one kind.
        expect(kinds.get(column.name) ?? column.kind).toBe(column.kind);
        kinds.set(column.name, column.kind);
        if (column.kind === "enum") expect(column.enum?.length).toBeGreaterThan(0);
        if (column.default !== undefined && column.enum) expect(column.enum).toContain(String(column.default));
      }
    }
    expect(importFieldKind("expectedMinutes")).toBe("number");
    expect(importFieldKind("splittable")).toBe("boolean");
    expect(importFieldKind("contexts")).toBe("list");
    expect(importFieldKind("unknown")).toBe("text");
  });

  it("derives the required lists, relation targets and template headers the pipeline used to spell out", () => {
    expect(REQUIRED_IMPORT_FIELDS.area).toEqual(["name", "status", "sortOrder"]);
    expect(REQUIRED_IMPORT_FIELDS.action).toEqual([
      "title",
      "status",
      "optimisticMinutes",
      "expectedMinutes",
      "pessimisticMinutes",
      "remainingMinutes",
      "energy",
      "minimumSessionMinutes",
      "maximumSessionMinutes",
      "splittable",
      "setupMinutes",
      "importance",
      "consequence"
    ]);
    expect(REQUIRED_IMPORT_FIELDS.condition_definition).toEqual(["name", "kind"]);
    expect(REQUIRED_IMPORT_FIELDS.dependency).toEqual([]);
    expect(REQUIRED_RELATIONSHIPS.dependency).toEqual(["actionKey", "dependsOnActionKey"]);
    expect(REQUIRED_RELATIONSHIPS.area).toBeUndefined();
    expect(IMPORT_RELATION_TYPES.dependsOnDeliverableKey).toBe("deliverable");
    expect(importTemplateHeaders("dependencies")).toEqual(["import_key", "action_key", "depends_on_action_key"]);
    expect(importTemplateHeaders("nope")).toEqual([]);
  });

  it("offers a dropdown for enums and booleans only, and describes each column once", () => {
    expect(importColumnChoices(importFieldSpec("action", "status")!)).toEqual([
      "inbox",
      "planned",
      "active",
      "doing",
      "waiting",
      "blocked",
      "done",
      "cancelled",
      "archived"
    ]);
    expect(importColumnChoices(importFieldSpec("action", "splittable")!)).toEqual(["true", "false"]);
    expect(importColumnChoices(importFieldSpec("action", "title")!)).toBeUndefined();
    expect(importColumnFormat(importFieldSpec("deliverable", "status")!)).toBe("needs_breakdown, cancelled, archived");
    expect(importColumnFormat(importFieldSpec("outcome", "reviewOn")!)).toBe("ISO date, `YYYY-MM-DD`");
    expect(importColumnFormat({ header: "x", name: "x", kind: "time" })).toBe("HH:MM, 24-hour clock");
  });

  it("offers both commitment sheets an optional place key, carried as a field rather than a relationship", () => {
    for (const entity of ["fixed_commitments", "fixed_commitment_recurrences"] as const) {
      const spec = importSpecs[entity]!;
      expect(importTemplateHeaders(entity)[1]).toBe("location_key");
      // The free-text label stays beside it: one is what the invitation said, the other is the place.
      expect(spec.columns.some((column) => column.header === "location")).toBe(true);
      const relation = importFieldRelation(spec.type, "locationId")!;
      expect(relation).toMatchObject({
        header: "location_key",
        targetType: "condition_definition",
        targetConditionKind: "location",
        asField: true
      });
      expect(relation.required).toBeUndefined();
      expect(importFieldRelations(spec.type)).toEqual([relation]);
    }
    // Carried as a field, so nothing looks for it among the relationship keys.
    expect(IMPORT_RELATION_TYPES.locationId).toBeUndefined();
    expect(REQUIRED_RELATIONSHIPS.fixed_commitment).toBeUndefined();
    expect(importFieldRelations("action")).toEqual([]);
    expect(importFieldRelation("fixed_commitment", "location")).toBeUndefined();
  });

  it("offers cadence as one optional number on the actions sheet, with nothing to default", () => {
    const column = importFieldSpec("action", "repeatEveryDays")!;
    expect(column).toMatchObject({ header: "repeat_every_days", kind: "number" });
    // Optional, and never invented on the user's behalf: a blank cell means ordinary one-off work.
    expect(column.required).toBeUndefined();
    expect(column.default).toBeUndefined();
    expect(REQUIRED_IMPORT_FIELDS.action).not.toContain("repeatEveryDays");
    // Sits with the other planning scores rather than at the end, where the timestamps are.
    const headers = importTemplateHeaders("actions");
    expect(headers.indexOf("repeat_every_days")).toBe(headers.indexOf("consequence") + 1);
  });

  it("defaults a status to a value the entity's own enum accepts", () => {
    expect(importFieldSpec("deliverable", "status")?.default).toBe("needs_breakdown");
    expect(importFieldSpec("fixed_commitment", "status")?.default).toBe("confirmed");
    expect(importFieldSpec("action", "status")?.default).toBe("active");
    expect(importFieldSpec("action", "title")?.default).toBeUndefined();
  });
});
