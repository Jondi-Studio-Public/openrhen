import { describe, expect, it } from "vitest";
import {
  conditionDefinitionSchema,
  currentSituationSchema,
  evaluateConditions,
  findCompositeCycles,
  resolveSituation,
  type CommitmentWindow,
  type ConditionDefinition,
  type CurrentSituation,
  type RequirementPathway
} from "@openrhen/contracts";

const now = new Date("2026-08-11T02:00:00.000Z");
const define = (input: Record<string, unknown>): ConditionDefinition => conditionDefinitionSchema.parse(input);
const situate = (input: Partial<CurrentSituation> = {}): CurrentSituation => currentSituationSchema.parse(input);
const pathway = (id: string, ...contextIds: string[]): RequirementPathway => ({ id, contextIds });

// Mirrors the real catalogue: home grants the desktop it physically contains, the laptop and phone
// travel with you, and video calls are a composite named for what it enables rather than a device class.
const definitions = [
  define({ id: "home", name: "Home", kind: "location", grants: ["desktop", "online"], travelMinutes: 20 }),
  define({ id: "college", name: "College campus", kind: "location", grants: ["online"], travelMinutes: 45 }),
  define({ id: "shops", name: "Shops", kind: "location", travelMinutes: 15 }),
  define({ id: "work", name: "Work", kind: "location", grants: ["manager", "colleague"] }),
  define({ id: "desktop", name: "Desktop", kind: "capability", portability: "fixed" }),
  define({ id: "online", name: "Internet", kind: "capability", portability: "fixed" }),
  define({ id: "laptop", name: "Laptop", kind: "capability", portability: "portable" }),
  define({ id: "phone", name: "Phone", kind: "capability", portability: "portable" }),
  define({ id: "manager", name: "Manager", kind: "contact", channels: ["in_person", "sync_remote"] }),
  define({ id: "colleague", name: "Colleague", kind: "contact", channels: ["in_person"] }),
  define({ id: "acquaintance", name: "Acquaintance", kind: "contact" }),
  define({ id: "retired", name: "Old tool", kind: "capability", status: "archived" }),
  define({
    id: "video-call",
    name: "Video call capable",
    kind: "capability",
    pathways: [
      ["desktop", "online"],
      ["laptop", "online"]
    ]
  })
];

const resolved = (situation: CurrentSituation, staleAfterMinutes?: number) =>
  resolveSituation({ situation, definitions, now, ...(staleAfterMinutes === undefined ? {} : { staleAfterMinutes }) });

const atHome = () => resolved(situate({ locationId: "home", locationSetAt: "2026-08-11T01:00:00.000Z" }));

describe("situation resolution", () => {
  it("infers fixed capabilities from the current location and leaves unmentioned ones known-absent", () => {
    const at = atHome();
    expect(at.resolve("home")).toBe("yes");
    expect(at.resolve("desktop")).toBe("yes");
    expect(at.resolve("online")).toBe("yes");
    expect(at.resolve("college")).toBe("no");
    expect(at.resolve("colleague")).toBe("no");
  });

  it("reports unknown rather than absent when no location is asserted", () => {
    const at = resolved(situate());
    expect(at.locationId).toBeNull();
    expect(at.resolve("home")).toBe("unknown");
    expect(at.resolve("desktop")).toBe("unknown");
    expect(at.resolve("colleague")).toBe("unknown");
  });

  it("lets an override beat the location it contradicts", () => {
    const at = resolved(
      situate({
        locationId: "home",
        locationSetAt: "2026-08-11T01:00:00.000Z",
        overrides: { desktop: "unavailable", manager: "available" }
      })
    );
    expect(at.resolve("desktop")).toBe("no");
    expect(at.resolve("manager")).toBe("yes");
  });

  it("expires a stale location to unknown instead of leaving it confidently wrong", () => {
    const at = resolved(situate({ locationId: "home", locationSetAt: "2026-08-10T12:00:00.000Z" }));
    expect(at.locationStale).toBe(true);
    expect(at.locationId).toBeNull();
    expect(at.resolve("desktop")).toBe("unknown");
  });

  it("fails closed on undefined and archived contexts", () => {
    const at = atHome();
    expect(at.resolve("never-defined")).toBe("no");
    expect(at.resolve("retired")).toBe("no");
  });
});

describe("contacts", () => {
  it("reaches a contact with a remote channel from anywhere, including with no location asserted", () => {
    expect(atHome().resolve("manager")).toBe("yes");
    expect(resolved(situate()).resolve("manager")).toBe("yes");
  });

  it("gates an in-person-only contact on being where they are", () => {
    expect(atHome().resolve("colleague")).toBe("no");
    expect(
      resolved(situate({ locationId: "work", locationSetAt: "2026-08-11T01:00:00.000Z" })).resolve("colleague")
    ).toBe("yes");
  });

  it("asks rather than refuses when no channel says how to reach them", () => {
    expect(atHome().resolve("acquaintance")).toBe("unknown");
  });

  it("still lets an override stand in for someone who is away", () => {
    const at = resolved(
      situate({ locationId: "home", locationSetAt: "2026-08-11T01:00:00.000Z", overrides: { manager: "unavailable" } })
    );
    expect(at.resolve("manager")).toBe("no");
  });
});

describe("portable capabilities", () => {
  it("keeps a carried device available across a location change while fixed ones drop", () => {
    const carrying = { laptop: true };
    const home = resolved(situate({ locationId: "home", locationSetAt: "2026-08-11T01:00:00.000Z", carrying }));
    expect(home.resolve("desktop")).toBe("yes");
    expect(home.resolve("laptop")).toBe("yes");

    const campus = resolved(situate({ locationId: "college", locationSetAt: "2026-08-11T01:00:00.000Z", carrying }));
    expect(campus.resolve("desktop")).toBe("no");
    expect(campus.resolve("laptop")).toBe("yes");
  });

  it("treats an unstated portable as unknown and an explicitly absent one as absent", () => {
    const at = atHome();
    expect(at.resolve("phone")).toBe("unknown");
    expect(
      resolved(
        situate({ locationId: "home", locationSetAt: "2026-08-11T01:00:00.000Z", carrying: { phone: false } })
      ).resolve("phone")
    ).toBe("no");
  });

  it("does not infer a portable from a location that happens to list it", () => {
    const withGrant = [...definitions, define({ id: "cafe", name: "Cafe", kind: "location", grants: ["laptop"] })];
    const at = resolveSituation({
      situation: situate({ locationId: "cafe", locationSetAt: "2026-08-11T01:00:00.000Z" }),
      definitions: withGrant,
      now
    });
    expect(at.resolve("laptop")).toBe("unknown");
  });
});

describe("composite capabilities", () => {
  it("is satisfied by whichever route actually holds", () => {
    expect(atHome().resolve("video-call")).toBe("yes");
    expect(
      resolved(
        situate({ locationId: "college", locationSetAt: "2026-08-11T01:00:00.000Z", carrying: { laptop: true } })
      ).resolve("video-call")
    ).toBe("yes");
  });

  it("is undetermined when every route depends on something unanswered", () => {
    expect(
      resolved(situate({ locationId: "college", locationSetAt: "2026-08-11T01:00:00.000Z" })).resolve("video-call")
    ).toBe("unknown");
  });

  it("is absent when every route is known to fail", () => {
    expect(
      resolved(
        situate({ locationId: "shops", locationSetAt: "2026-08-11T01:00:00.000Z", carrying: { laptop: false } })
      ).resolve("video-call")
    ).toBe("no");
  });

  it("lets an explicit override short-circuit the pathways", () => {
    expect(
      resolved(
        situate({
          locationId: "shops",
          locationSetAt: "2026-08-11T01:00:00.000Z",
          overrides: { "video-call": "available" }
        })
      ).resolve("video-call")
    ).toBe("yes");
  });

  it("survives a self-referential definition instead of recursing forever", () => {
    const cyclic = [
      define({ id: "a", name: "A", kind: "capability", pathways: [["b"]] }),
      define({ id: "b", name: "B", kind: "capability", pathways: [["a"]] })
    ];
    expect(findCompositeCycles(cyclic)).not.toHaveLength(0);
    const at = resolveSituation({ situation: situate({ locationId: null }), definitions: cyclic, now });
    expect(at.resolve("a")).toBe("no");
    expect(at.cycles).not.toHaveLength(0);
  });

  it("finds no cycles in a well-formed catalogue", () => {
    expect(findCompositeCycles(definitions)).toEqual([]);
  });
});

describe("pathway evaluation", () => {
  it("treats an action with no stated requirements as unconstrained", () => {
    expect(evaluateConditions({ pathways: [], resolved: resolved(situate()) }).status).toBe("yes");
  });

  it("names the pathway that succeeded", () => {
    const match = evaluateConditions({ pathways: [pathway("p1", "desktop", "online")], resolved: atHome() });
    expect(match.status).toBe("yes");
    expect(match.satisfiedPathwayId).toBe("p1");
  });

  it("lets a known miss beat an open question inside one pathway", () => {
    const match = evaluateConditions({ pathways: [pathway("p1", "college", "phone")], resolved: atHome() });
    expect(match.status).toBe("no");
    expect(match.missing).toEqual(["college"]);
    expect(match.unknowns).toEqual(["phone"]);
  });

  it("lets a satisfied pathway beat an unsatisfied one", () => {
    const match = evaluateConditions({
      pathways: [pathway("campus", "college"), pathway("remote", "desktop", "online")],
      resolved: atHome()
    });
    expect(match.status).toBe("yes");
    expect(match.satisfiedPathwayId).toBe("remote");
  });

  it("lets an open question beat a known failure across pathways", () => {
    const match = evaluateConditions({
      pathways: [pathway("campus", "college"), pathway("mobile", "phone")],
      resolved: atHome()
    });
    expect(match.status).toBe("unknown");
    expect(match.unknowns).toEqual(["phone"]);
    expect(match.missing).toEqual([]);
  });

  it("is ineligible only when every pathway is known to fail", () => {
    const match = evaluateConditions({
      pathways: [pathway("campus", "college"), pathway("office", "work")],
      resolved: atHome()
    });
    expect(match.status).toBe("no");
  });

  it("reports against the closest pathway rather than the first authored", () => {
    const match = evaluateConditions({
      pathways: [pathway("far", "college", "work", "retired"), pathway("near", "shops")],
      resolved: atHome()
    });
    expect(match.missing).toEqual(["shops"]);
  });

  it("collects unmet preferences without letting them affect eligibility", () => {
    const match = evaluateConditions({
      pathways: [pathway("p1", "desktop")],
      preferences: ["online", "phone", "college"],
      resolved: atHome()
    });
    expect(match.status).toBe("yes");
    expect(match.unmetPreferences).toEqual(["phone", "college"]);
  });
});

describe("initiable versus executable", () => {
  it("offers the trip when being elsewhere is the only obstacle", () => {
    const match = evaluateConditions({ pathways: [pathway("errand", "shops")], resolved: atHome() });
    expect(match.status).toBe("no");
    expect(match.reachableVia).toEqual({ locationId: "shops", travelMinutes: 15 });
  });

  it("withholds the trip while an open question remains", () => {
    const match = evaluateConditions({ pathways: [pathway("errand", "shops", "phone")], resolved: atHome() });
    expect(match.reachableVia).toBeUndefined();
  });

  it("withholds the trip when the location has no known travel cost", () => {
    const match = evaluateConditions({ pathways: [pathway("office", "work")], resolved: atHome() });
    expect(match.reachableVia).toBeUndefined();
  });

  it("withholds the trip when something other than a location is also missing", () => {
    const match = evaluateConditions({ pathways: [pathway("errand", "shops", "retired")], resolved: atHome() });
    expect(match.reachableVia).toBeUndefined();
  });
});

describe("how you can travel", () => {
  const situated = (extra: Partial<CurrentSituation>) =>
    resolved(situate({ locationId: "home", locationSetAt: "2026-08-11T01:00:00.000Z", ...extra }));
  const errand = (at: ReturnType<typeof resolved>) =>
    evaluateConditions({ pathways: [pathway("errand", "shops")], resolved: at });

  it("offers nothing anywhere when no way of travelling is available", () => {
    // The whole point of the toggles: with no car, no bike and no ability to walk, work that needs
    // another place is not a choice, and offering it as one is noise.
    expect(errand(situated({ transportModes: [] })).reachableVia).toBeUndefined();
  });

  it("prefers a measured journey over the location's stored fallback", () => {
    const at = situated({ travel: { shops: { minutes: 6, mode: "bike", refreshedAt: "2026-08-11T01:30:00.000Z" } } });
    expect(errand(at).reachableVia).toEqual({ locationId: "shops", travelMinutes: 6, mode: "bike" });
  });

  it("falls back to the stored figure when the measured journey used a mode you no longer have", () => {
    const at = situated({
      transportModes: ["walk"],
      travel: { shops: { minutes: 6, mode: "bike", refreshedAt: "2026-08-11T01:30:00.000Z" } }
    });
    expect(errand(at).reachableVia).toEqual({ locationId: "shops", travelMinutes: 15 });
  });

  it("still withholds the trip when neither a measurement nor a fallback exists", () => {
    const at = situated({ travel: { shops: { minutes: 6, mode: "bike", refreshedAt: "2026-08-11T01:30:00.000Z" } } });
    expect(evaluateConditions({ pathways: [pathway("office", "work")], resolved: at }).reachableVia).toBeUndefined();
  });
});

describe("live context definitions", () => {
  it("requires exactly one of recurrenceRuleId/commitmentId when kind is live", () => {
    expect(() => define({ id: "ctx-college", name: "College class", kind: "live" })).toThrow();
    expect(() =>
      define({
        id: "ctx-college",
        name: "College class",
        kind: "live",
        recurrenceRuleId: "rule-college",
        commitmentId: "commitment-dentist"
      })
    ).toThrow();
    expect(() =>
      define({ id: "ctx-college", name: "College class", kind: "live", recurrenceRuleId: "rule-college" })
    ).not.toThrow();
    expect(() =>
      define({ id: "ctx-dentist", name: "Dentist", kind: "live", commitmentId: "commitment-dentist" })
    ).not.toThrow();
  });

  it("forbids recurrenceRuleId/commitmentId on every other kind", () => {
    expect(() => define({ id: "home", name: "Home", kind: "location", recurrenceRuleId: "rule-college" })).toThrow();
    expect(() =>
      define({ id: "desk", name: "Desk", kind: "capability", commitmentId: "commitment-dentist" })
    ).toThrow();
  });
});

describe("live contexts", () => {
  const ruleContext = define({
    id: "ctx-college",
    name: "College class",
    kind: "live",
    recurrenceRuleId: "rule-college"
  });
  const oneOffContext = define({
    id: "ctx-dentist",
    name: "Dentist",
    kind: "live",
    commitmentId: "commitment-dentist"
  });
  const commitmentDefs = [ruleContext, oneOffContext];
  const at = new Date("2026-09-04T00:00:00.000Z"); // Friday 10:00 local (+10)
  const window = (overrides: Partial<CommitmentWindow>): CommitmentWindow => ({
    id: "occ-1",
    status: "confirmed",
    startsAt: "2026-09-04T00:00:00.000Z",
    endsAt: "2026-09-04T02:00:00.000Z",
    ...overrides
  });
  const resolveWith = (commitments: CommitmentWindow[], now = at) =>
    resolveSituation({ situation: situate(), definitions: commitmentDefs, now, commitments });

  it("is satisfied while now sits inside a live confirmed occurrence of the matching rule", () => {
    const resolved = resolveWith([window({ recurrenceRuleId: "rule-college" })], new Date("2026-09-04T01:00:00.000Z"));
    expect(resolved.resolve("ctx-college")).toBe("yes");
  });

  it("is unsatisfied before the occurrence starts and after it ends", () => {
    const commitments = [window({ recurrenceRuleId: "rule-college" })];
    expect(resolveWith(commitments, new Date("2026-09-03T23:59:00.000Z")).resolve("ctx-college")).toBe("no");
    expect(resolveWith(commitments, new Date("2026-09-04T02:00:00.000Z")).resolve("ctx-college")).toBe("no");
  });

  it("ignores a matching occurrence that is not confirmed", () => {
    const cancelled = window({ recurrenceRuleId: "rule-college", status: "cancelled" });
    expect(resolveWith([cancelled], new Date("2026-09-04T01:00:00.000Z")).resolve("ctx-college")).toBe("no");
  });

  it("matches a one-off commitment by its own id, not by any recurrence rule", () => {
    const commitments = [window({ id: "commitment-dentist", recurrenceRuleId: undefined })];
    expect(resolveWith(commitments, new Date("2026-09-04T01:00:00.000Z")).resolve("ctx-dentist")).toBe("yes");
    expect(resolveWith(commitments, new Date("2026-09-04T01:00:00.000Z")).resolve("ctx-college")).toBe("no");
  });

  it("resolves unsatisfied, never unknown, when no commitments are threaded through at all", () => {
    const resolved = resolveSituation({ situation: situate(), definitions: commitmentDefs, now: at });
    expect(resolved.resolve("ctx-college")).toBe("no");
    expect(resolved.resolve("ctx-dentist")).toBe("no");
  });

  it("attaches hold copy naming the next occurrence when the only miss is the commitment context", () => {
    const commitments = [
      window({
        id: "occ-past",
        recurrenceRuleId: "rule-college",
        title: "College — Cert IV",
        startsAt: "2026-09-03T00:00:00.000Z",
        endsAt: "2026-09-03T02:00:00.000Z"
      }),
      window({
        id: "occ-next",
        recurrenceRuleId: "rule-college",
        title: "College — Cert IV",
        startsAt: "2026-09-11T00:00:00.000Z",
        endsAt: "2026-09-11T02:00:00.000Z"
      })
    ];
    const resolved = resolveWith(commitments, at);
    const match = evaluateConditions({ pathways: [pathway("class", "ctx-college")], resolved });
    expect(match.status).toBe("no");
    expect(match.commitmentHold).toEqual({
      unavailableReason: "Only during College — Cert IV.",
      availableFrom: "2026-09-11T00:00:00.000Z"
    });
  });

  it("falls back to the context's own name when no future occurrence is already known", () => {
    const resolved = resolveWith([], at);
    const match = evaluateConditions({ pathways: [pathway("class", "ctx-college")], resolved });
    expect(match.commitmentHold).toEqual({ unavailableReason: "Only during College class." });
  });

  it("omits commitment hold copy once something else is also missing", () => {
    const resolved = resolveWith([], at);
    const match = evaluateConditions({ pathways: [pathway("class", "ctx-college", "retired")], resolved });
    expect(match.commitmentHold).toBeUndefined();
  });
});
