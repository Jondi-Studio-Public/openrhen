import { describe, expect, it } from "vitest";
import { resolveRequires, type RequirementDefinition } from "./requires.js";

const defs: RequirementDefinition[] = [
  { id: "home", name: "Home", kind: "location", status: "active", channels: [] },
  { id: "garage", name: "Garage", kind: "location", status: "active", channels: [] },
  { id: "workbench", name: "Workbench", kind: "capability", status: "active", channels: [] },
  { id: "pete", name: "Pete", kind: "contact", status: "active", channels: [] },
  { id: "mia", name: "Mia", kind: "contact", status: "active", channels: ["sync_remote"] },
  { id: "sam", name: "Sam", kind: "contact", status: "active", channels: ["in_person"] },
  { id: "old", name: "Old", kind: "contact", status: "archived", channels: ["sync_remote"] }
];

const ok = (requires: unknown[]) => {
  const result = resolveRequires(requires, defs);
  if (!result.ok) throw new Error(result.message);
  return result;
};
const fail = (requires: unknown[]) => {
  const result = resolveRequires(requires, defs);
  if (result.ok) throw new Error("expected a refusal");
  return result;
};

describe("resolveRequires accepts", () => {
  it("plain ids and tagged people, all of them", () => {
    expect(ok(["garage", "pete@with"]).keys).toEqual(["garage", "pete@with"]);
    expect(ok(["home", "mia@remote"]).keys).toEqual(["home", "mia@remote"]);
    expect(ok(["workbench"]).keys).toEqual(["workbench"]);
  });

  it("[] clears", () => {
    expect(ok([]).keys).toEqual([]);
  });

  it("dedupes exact repeats, keeping the first order", () => {
    expect(ok(["garage", "pete@with", "garage", "pete@with"]).keys).toEqual(["garage", "pete@with"]);
  });

  it("trims whitespace", () => {
    expect(ok([" garage ", "pete@with "]).keys).toEqual(["garage", "pete@with"]);
  });

  it("lets @with take a contact with no channel recorded", () => {
    expect(ok(["pete@with"]).keys).toEqual(["pete@with"]);
  });
});

describe("resolveRequires refuses", () => {
  it("a bare person, naming both forms and the fix", () => {
    const refusal = fail(["garage", "pete"]);
    expect(refusal.message).toContain("pete is a person");
    expect(refusal.message).toContain("pete@with");
    expect(refusal.message).toContain("pete@remote");
    expect(refusal.message).toContain("physically with you");
    expect(refusal.message).toContain("Nothing was saved");
  });

  it("a tag on a place or capability", () => {
    expect(fail(["home@remote"]).message).toContain("home is not a person");
    expect(fail(["workbench@with"]).message).toContain("takes no tag");
  });

  it("an unknown id, offering a name-only contact created from notes", () => {
    const refusal = fail(["garage", "dave@with"]);
    expect(refusal.message).toContain('"dave"');
    expect(refusal.message).toContain("from notes");
    expect(refusal.nextCall).toMatchObject({
      tool: "rhen_save",
      arguments: {
        entityType: "condition_definition",
        id: "dave",
        create: true,
        fields: { name: "Dave", kind: "contact" }
      }
    });
    expect(refusal.message).toContain("then repeat this call");
    expect(refusal.validValues?.ids).toContain("garage");
  });

  it("an unknown bare id offers the same, but as a place or capability it cannot guess", () => {
    const refusal = fail(["shed"]);
    expect(refusal.message).toContain('"shed"');
    expect(refusal.message).toContain("rhen_list");
    expect(refusal.nextCall?.tool).toBe("rhen_list");
  });

  it("an archived person", () => {
    expect(fail(["old@with"]).message).toContain("archived");
  });

  it("@remote on a contact with no remote channel", () => {
    const none = fail(["pete@remote"]);
    expect(none.message).toContain("no way to reach");
    expect(none.message).toContain("pete@with");
    const inPerson = fail(["sam@remote"]);
    expect(inPerson.message).toContain("only be met in person");
  });

  it("conflicting tags on one person", () => {
    const refusal = fail(["mia@with", "mia@remote"]);
    expect(refusal.message).toContain("mia");
    expect(refusal.message).toContain("both");
  });

  it("non-string and blank entries", () => {
    expect(fail([""]).message).toContain("blank");
    expect(fail([42]).message).toContain("text");
  });

  it("more than twelve", () => {
    expect(fail(Array.from({ length: 13 }, (_, i) => `x${i}`)).message).toContain("12");
  });

  it("collects every problem in one go, so the agent fixes them together", () => {
    const refusal = fail(["pete", "home@remote", "ghost"]);
    expect(refusal.problems.map((p) => p.code)).toEqual(["bare_person", "tag_on_non_person", "unknown_id"]);
  });
});
