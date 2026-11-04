import { describe, expect, it } from "vitest";
import {
  activeConditionIds,
  conditionRequirementCounts,
  describeCondition,
  matchConditionDefinitions,
  placeOptions,
  placeTravelNote,
  withPlace,
  type ConditionDefinition
} from "@/features/settings/context-summary";
import type { PortalState } from "@/state/portal-state";

const definition = (overrides: Partial<ConditionDefinition> & { id: string; name: string }): ConditionDefinition => ({
  kind: "capability",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: [],
  ...overrides
});

const action = (contexts: string[], pathways?: { id: string; contextIds: string[] }[]) =>
  ({ contexts, ...(pathways ? { requirementPathways: pathways } : {}) }) as PortalState["actions"][number];

describe("describeCondition", () => {
  it("says what a location grants and how far away it is", () => {
    const entry = definition({ id: "home", name: "Home", kind: "location", grants: ["desk"], travelMinutes: 12 });
    expect(describeCondition(entry)).toBe("grants desk · 12 min away");
  });

  it("distinguishes a contact you can message from one you must meet", () => {
    const remote = definition({ id: "sam", name: "Sam", kind: "contact", channels: ["async"] });
    const inPerson = definition({ id: "kim", name: "Kim", kind: "contact", channels: ["in_person"] });
    const unset = definition({ id: "lee", name: "Lee", kind: "contact" });
    expect(describeCondition(remote)).toBe("reachable anywhere");
    expect(describeCondition(inPerson)).toBe("in person only");
    expect(describeCondition(unset)).toBe("no channel set, so always asks");
  });

  it("prefers the pathway count over portability for a composite capability", () => {
    const composite = definition({ id: "call", name: "Call", pathways: [["phone"], ["laptop"]] });
    expect(describeCondition(composite)).toBe("built from 2 routes");
    expect(describeCondition(definition({ id: "phone", name: "Phone", portability: "portable" }))).toBe(
      "travels with you"
    );
  });
});

describe("condition usage counts", () => {
  it("counts an action once per condition even when a pathway repeats it", () => {
    const counts = conditionRequirementCounts([
      action(
        [],
        [
          { id: "a", contextIds: ["home", "desk"] },
          { id: "b", contextIds: ["home"] }
        ]
      ),
      action(["home"])
    ]);
    expect(counts.get("home")).toBe(2);
    expect(counts.get("desk")).toBe(1);
  });

  it("falls back to the legacy tags when an action has no pathways", () => {
    expect(conditionRequirementCounts([action(["home", "home"])]).get("home")).toBe(1);
  });
});

describe("activeConditionIds", () => {
  it("offers only active typed conditions, the picker vocabulary now that the flat catalogue is retired", () => {
    const definitions = [
      definition({ id: "home", name: "Home" }),
      definition({ id: "shed", name: "Old shed", status: "archived" })
    ];
    expect(activeConditionIds(definitions)).toEqual(["home"]);
  });
});

describe("matchConditionDefinitions", () => {
  const group = [
    definition({ id: "harbor-mart-riverside", name: "Harbor Mart" }),
    definition({ id: "home", name: "Home office" })
  ];

  it("returns everything when nothing is typed", () => {
    expect(matchConditionDefinitions(group, "  ")).toHaveLength(2);
  });

  it("matches the id as well as the name", () => {
    expect(matchConditionDefinitions(group, "riverside").map((entry) => entry.id)).toEqual(["harbor-mart-riverside"]);
    expect(matchConditionDefinitions(group, "OFFICE").map((entry) => entry.id)).toEqual(["home"]);
  });
});

describe("place picking", () => {
  const definitions = [
    definition({ id: "home", name: "Home", kind: "location", travelMinutes: 0 }),
    definition({ id: "campus", name: "Campus", kind: "location", travelMinutes: 17.6 }),
    definition({ id: "shed", name: "Old shed", kind: "location", status: "archived" }),
    definition({ id: "dentist", name: "Dentist, Riverside", kind: "location", oneOff: true }),
    definition({ id: "desk", name: "Desk" })
  ];

  it("offers the active locations only, and nothing that is not a place", () => {
    expect(placeOptions(definitions).map((option) => option.id)).toEqual(["home", "campus"]);
  });

  it("keeps an archived place while it is the one already chosen", () => {
    expect(placeOptions(definitions, "shed").map((option) => option.id)).toEqual(["home", "campus", "shed"]);
  });

  it("hides a one-off place from the general offer but keeps it while chosen", () => {
    expect(placeOptions(definitions).map((option) => option.id)).not.toContain("dentist");
    expect(placeOptions(definitions, "dentist").map((option) => option.id)).toEqual(["home", "campus", "dentist"]);
  });

  it("quotes the saved fallback figure, and says nothing when a place has none", () => {
    const options = placeOptions(definitions, "shed");
    expect(placeTravelNote(options, "campus")).toBe("~18 min from home");
    expect(placeTravelNote(options, "home")).toBe("~0 min from home");
    expect(placeTravelNote(options, "shed")).toBe("");
    expect(placeTravelNote(options, "")).toBe("");
  });

  it("names the place in an empty label but never overwrites one that was typed", () => {
    const options = placeOptions(definitions);
    expect(withPlace({ location: "", locationId: "" }, "campus", options)).toEqual({
      location: "Campus",
      locationId: "campus"
    });
    expect(withPlace({ location: "   ", locationId: "" }, "campus", options)).toEqual({
      location: "Campus",
      locationId: "campus"
    });
    expect(withPlace({ location: "Room 2.14", locationId: "" }, "campus", options)).toEqual({
      location: "Room 2.14",
      locationId: "campus"
    });
  });

  it("clears the place without disturbing the label", () => {
    const options = placeOptions(definitions);
    expect(withPlace({ location: "Campus", locationId: "campus" }, "", options)).toEqual({
      location: "Campus",
      locationId: ""
    });
  });
});
