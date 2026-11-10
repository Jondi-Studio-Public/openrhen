import { describe, expect, it } from "vitest";
import { doctorPeopleItems, type DoctorPeopleSlice } from "./doctor-people.js";
import { conditionDefinitionSchema, currentSituationSchema } from "./context-model.js";

const NOW = Date.parse("2026-11-02T00:00:00Z");
const define = (input: Record<string, unknown>) => conditionDefinitionSchema.parse(input);

const slice = (over: Partial<DoctorPeopleSlice> = {}): DoctorPeopleSlice => ({
  situation: currentSituationSchema.parse({}),
  definitions: [
    define({ id: "pete", name: "Pete", kind: "contact", channels: ["sync_remote"] }),
    define({ id: "sam", name: "Sam", kind: "contact", channels: ["in_person"] }),
    define({ id: "gone", name: "Gone", kind: "contact", channels: ["sync_remote"], status: "archived" })
  ],
  commitments: [],
  timeZone: "UTC",
  work: [],
  ...over
});
const work = (id: string, keys: string[], deadlineAt: string | null) => ({
  id,
  title: `Work ${id}`,
  pathways: [{ id: `${id}-p`, contextIds: keys }],
  deadlineAt
});

describe("person_waiting_deadline", () => {
  it("is silent while the deadline is far off", () => {
    expect(doctorPeopleItems(slice({ work: [work("a", ["pete@with"], "2026-12-30T00:00:00Z")] }), NOW)).toEqual([]);
  });

  it("raises a person decision once deadline minus lead time is reached, for an unknown person", () => {
    const items = doctorPeopleItems(slice({ work: [work("a", ["pete@with"], "2026-11-06T00:00:00Z")] }), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      check: "person_waiting_deadline",
      handles: ["action:a"],
      dueAt: "2026-11-06T00:00:00.000Z",
      fix: { who: "person" }
    });
    expect(items[0]!.fix.question).toMatch(/Pete/);
  });

  it("raises it for a known no too, and when the deadline has already passed", () => {
    const away = currentSituationSchema.parse({
      presence: { pete: { state: "away", setAt: "2026-11-02T00:00:00Z", until: "2026-11-03T00:00:00Z" } }
    });
    expect(
      doctorPeopleItems(slice({ situation: away, work: [work("a", ["pete@with"], "2026-11-05T00:00:00Z")] }), NOW)
    ).toHaveLength(1);
    expect(doctorPeopleItems(slice({ work: [work("a", ["pete@with"], "2026-10-30T00:00:00Z")] }), NOW)).toHaveLength(1);
  });

  it("is silent when the person is here, when waived, or when there is no deadline", () => {
    const here = currentSituationSchema.parse({
      presence: { pete: { state: "here", setAt: "2026-11-02T00:00:00Z", until: "2026-11-03T00:00:00Z" } }
    });
    const deadline = "2026-11-03T00:00:00Z";
    expect(doctorPeopleItems(slice({ situation: here, work: [work("a", ["pete@with"], deadline)] }), NOW)).toEqual([]);
    expect(doctorPeopleItems(slice({ work: [work("a", ["pete@with"], null)] }), NOW)).toEqual([]);
    const waived = currentSituationSchema.parse({
      waivers: { a: { people: ["pete"], setAt: "2026-11-01T10:00:00Z", until: "2026-11-08T00:00:00Z" } }
    });
    expect(doctorPeopleItems(slice({ situation: waived, work: [work("a", ["pete@with"], deadline)] }), NOW)).toEqual(
      []
    );
  });

  it("ignores bare ids and @remote", () => {
    expect(
      doctorPeopleItems(
        slice({
          work: [work("a", ["pete"], "2026-11-03T00:00:00Z"), work("b", ["pete@remote"], "2026-11-03T00:00:00Z")]
        }),
        NOW
      )
    ).toEqual([]);
  });
});

describe("requirement_unresolvable", () => {
  it("flags an undefined person, an archived person and a person who is not a contact", () => {
    const items = doctorPeopleItems(
      slice({
        work: [
          work("a", ["nope@with"], null),
          work("b", ["gone@with"], null),
          work("c", ["pete@with", "pete@remote"], null)
        ]
      }),
      NOW
    ).filter((i) => i.check === "requirement_unresolvable");
    expect(items.map((i) => i.handles[0])).toEqual(["action:a", "action:b"]);
    expect(items[0]!.fix.who).toBe("agent");
  });

  it("flags @remote on a contact with no remote channel", () => {
    const items = doctorPeopleItems(slice({ work: [work("a", ["sam@remote"], null)] }), NOW);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ check: "requirement_unresolvable" });
    expect(items[0]!.why).toMatch(/channel/);
  });

  it("does not flag a defined id that merely looks tagged", () => {
    const defs = [define({ id: "pete", name: "P", kind: "contact", channels: ["sync_remote"] })];
    expect(doctorPeopleItems(slice({ definitions: defs, work: [work("a", ["pete@remote"], null)] }), NOW)).toEqual([]);
  });
});
