import { describe, expect, it } from "vitest";
import {
  PlanMapQueryError,
  buildPlanIndex,
  navigate,
  parseKinds,
  resolveItem,
  resolveStoredEnd,
  toStoredLinks,
  type StoredLink,
  type StoredLinkRow
} from "../../plan-map-navigator.js";

const now = new Date("2026-09-04T00:00:00.000Z");

function state() {
  return {
    areas: [{ id: "area-study", name: "Study", status: "active" }],
    projects: [
      {
        id: "p1",
        title: "Thesis",
        status: "active",
        area: "area-study",
        value: 3,
        consequence: 2
      },
      { id: "p2", title: "Thesis notes", status: "active", value: 1, consequence: 1 }
    ],
    actions: [
      {
        id: "a1",
        title: "Read paper",
        status: "ready",
        projectId: "p1",
        remainingMinutes: 30,
        energy: "low"
      }
    ],
    commitments: [
      {
        id: "c1",
        title: "Meeting",
        status: "confirmed",
        startsAt: "2026-09-05T00:00:00.000Z",
        projectId: "p1"
      }
    ],
    commitmentRecurrenceRules: [
      {
        id: "rule-squad",
        title: "Swim squad",
        status: "active",
        localStartTime: "06:00",
        localEndTime: "07:00",
        startDate: "2026-08-01"
      }
    ]
  };
}

const subjects = [{ id: "maths", name: "Maths" }];
const index = () => buildPlanIndex(state(), { subjects });
const options = (stored: StoredLink[], includeSuggested = false) => ({
  depth: 1,
  kinds: new Set<string>(),
  budget: 100_000,
  stored,
  includeSuggested,
  now
});
const about = (status: "confirmed" | "suggested", to = "subject:maths"): StoredLink => ({
  from: "action:a1",
  to,
  kind: "about",
  status
});

describe("subjects", () => {
  it("appear as subject:<id> items", () => {
    const item = index().items.get("subject:maths");
    expect(item).toMatchObject({ handle: "subject:maths", type: "subject", title: "Maths" });
  });

  it("are absent when no subjects are supplied", () => {
    expect(buildPlanIndex(state()).items.has("subject:maths")).toBe(false);
  });
});

describe("navigate with stored links", () => {
  it("shows a confirmed about link from an action to a subject as a stored edge", () => {
    const idx = index();
    const result = navigate(idx, resolveItem(idx, "action:a1"), options([about("confirmed")]));
    expect(result.cards.map((card) => card.handle)).toContain("subject:maths");
    expect(result.edges).toContainEqual(
      expect.objectContaining({
        from: "action:a1",
        to: "subject:maths",
        kind: "about",
        origin: "stored",
        status: "confirmed"
      })
    );
  });

  it("excludes a suggested link unless includeSuggested", () => {
    const idx = index();
    const root = resolveItem(idx, "action:a1");
    const without = navigate(idx, root, options([about("suggested")]));
    expect(without.edges.some((edge) => edge.origin === "stored")).toBe(false);
    expect(without.cards.map((card) => card.handle)).not.toContain("subject:maths");

    const withIt = navigate(idx, root, options([about("suggested")], true));
    expect(withIt.edges).toContainEqual(
      expect.objectContaining({ to: "subject:maths", origin: "stored", status: "suggested" })
    );
  });

  it("attaches a link stored as commitment:<ruleId> to the rule item", () => {
    const idx = index();
    const result = navigate(
      idx,
      resolveItem(idx, "rule:rule-squad"),
      options([about("confirmed", "subject:maths")].map((l) => ({ ...l, from: "commitment:rule-squad" })))
    );
    expect(result.edges).toContainEqual(
      expect.objectContaining({ from: "rule:rule-squad", to: "subject:maths", origin: "stored" })
    );
  });

  it("drops a stored link whose end is not in the plan", () => {
    const idx = index();
    const result = navigate(idx, resolveItem(idx, "action:a1"), options([about("confirmed", "subject:gone")]));
    expect(result.edges.some((edge) => edge.origin === "stored")).toBe(false);
  });
});

describe("resolveStoredEnd", () => {
  it("maps commitment:<ruleId> to the rule when no such commitment exists", () => {
    expect(resolveStoredEnd(index(), "commitment:rule-squad")).toBe("rule:rule-squad");
  });
  it("keeps a real commitment, and an unknown id, as they are", () => {
    expect(resolveStoredEnd(index(), "commitment:c1")).toBe("commitment:c1");
    expect(resolveStoredEnd(index(), "commitment:nothing")).toBe("commitment:nothing");
  });
});

describe("toStoredLinks", () => {
  const row = (overrides: Partial<StoredLinkRow>): StoredLinkRow => ({
    fromType: "action",
    fromId: "a1",
    toType: "subject",
    toId: "maths",
    kind: "about",
    status: "confirmed",
    ...overrides
  });

  it("keeps confirmed and suggested rows in handle form", () => {
    expect(toStoredLinks([row({}), row({ status: "suggested" })])).toEqual([
      { from: "action:a1", to: "subject:maths", kind: "about", status: "confirmed" },
      { from: "action:a1", to: "subject:maths", kind: "about", status: "suggested" }
    ]);
  });

  it("drops rejected and expired rows and unknown kinds", () => {
    expect(
      toStoredLinks([row({ status: "rejected" }), row({ status: "expired" }), row({ kind: "from_the_future" })])
    ).toEqual([]);
  });

  it("joins evidence, and omits it when empty", () => {
    const [withEvidence, without] = toStoredLinks([
      row({ evidence: ["title match", "same week"] }),
      row({ evidence: [] })
    ]);
    expect(withEvidence?.evidence).toEqual(["title match", "same week"]);
    expect(without).not.toHaveProperty("evidence");

    const idx = index();
    const result = navigate(idx, resolveItem(idx, "action:a1"), options([withEvidence!]));
    expect(result.edges.find((edge) => edge.origin === "stored")?.evidence).toBe("title match; same week");
  });
});

describe("resolveItem", () => {
  it("throws ambiguous when several items match", () => {
    expect.assertions(2);
    try {
      resolveItem(index(), "p");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanMapQueryError);
      expect((error as PlanMapQueryError).code).toBe("ambiguous");
    }
  });

  it("throws not_found when nothing matches", () => {
    expect.assertions(2);
    try {
      resolveItem(index(), "project:nope");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanMapQueryError);
      expect((error as PlanMapQueryError).code).toBe("not_found");
    }
  });

  it("finds an item by handle, bare id, or exact title", () => {
    expect(resolveItem(index(), "project:p1").handle).toBe("project:p1");
    expect(resolveItem(index(), "a1").handle).toBe("action:a1");
    expect(resolveItem(index(), "Read paper").handle).toBe("action:a1");
  });
});

describe("parseKinds", () => {
  it("throws unknown_kind for a kind that is not defined", () => {
    expect.assertions(2);
    try {
      parseKinds("about,nonsense");
    } catch (error) {
      expect(error).toBeInstanceOf(PlanMapQueryError);
      expect((error as PlanMapQueryError).code).toBe("unknown_kind");
    }
  });

  it("parses a comma list, ignoring blanks", () => {
    expect([...parseKinds("about, parent_child,")]).toEqual(["about", "parent_child"]);
    expect(parseKinds(undefined).size).toBe(0);
  });
});
