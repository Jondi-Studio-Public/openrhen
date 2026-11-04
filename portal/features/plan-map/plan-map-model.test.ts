import { describe, expect, it } from "vitest";
import { SWITCHABLE_ADDONS, type SwitchableAddon } from "@openrhen/contracts";
import {
  ADDON_LABELS,
  availableRelations,
  bulkConfirmGroups,
  buildTitleResolver,
  candidatesFor,
  connectionCandidates,
  describeItemLink,
  describeSuggestedChange,
  groupSuggestedLinks,
  itemRefFor,
  linkInputFor,
  linksForItem,
  modeOptions,
  ON_OFF_ONLY_ADDONS,
  openCount,
  parseHandle,
  recentlyDecided,
  RELATIONS,
  switchRows
} from "./plan-map-model";
import { finding, link, planMap, titles } from "./test-fixtures";

const map = planMap();
const resolver = buildTitleResolver(titles, map);

describe("title resolution", () => {
  it("resolves each item type, subjects from the map, and falls back to the id", () => {
    expect(resolver.titleOf("action", "a1")).toBe("Practice paper");
    expect(resolver.titleOf("subject", "maths")).toBe("Maths");
    expect(resolver.titleOf("commitment", "rule-squad")).toBe("Swim squad");
    expect(resolver.titleOf("project", "gone")).toBe("gone");
    expect(resolver.titleOf("place", "x")).toBe("x");
  });

  it("resolves a deliverable's step as an action, though state.actions leaves steps out", () => {
    const withSteps = buildTitleResolver(
      {
        ...titles,
        deliverables: [{ id: "d9", title: "Report", steps: [{ id: "step-1", title: "Draft the report" }] }]
      },
      map
    );
    expect(withSteps.titleOf("action", "step-1")).toBe("Draft the report");
    expect(withSteps.handleTitle("action:step-1")).toBe("Draft the report");
    expect(withSteps.titleOf("deliverable", "d9")).toBe("Report");
    // An action that is truly gone still shows its id.
    expect(withSteps.titleOf("action", "step-gone")).toBe("step-gone");
    const [row] = recentlyDecided(
      {
        links: [
          link({
            fromType: "action",
            fromId: "step-1",
            toType: "action",
            toId: "a1",
            kind: "before",
            status: "confirmed",
            decidedAt: "2026-09-24T00:00:00.000Z"
          })
        ],
        findings: []
      },
      withSteps.titleOf,
      Date.parse("2026-09-25T00:00:00.000Z")
    );
    expect(row!.title).toBe("Draft the report comes before Practice paper");
  });

  it("resolves handles, keeping colons inside the id", () => {
    expect(parseHandle("project:a:b")).toEqual({ type: "project", id: "a:b" });
    expect(parseHandle("nonsense")).toBeNull();
    expect(resolver.handleTitle("project:p1")).toBe("Maths exam");
    expect(resolver.handleTitle("nonsense")).toBe("nonsense");
  });
});

describe("groupSuggestedLinks", () => {
  it("groups by subject, then project, then other, skipping decided links", () => {
    const links = [
      link({ fromId: "a1", toId: "maths" }),
      link({ fromId: "a2", toId: "meals" }),
      link({ fromType: "action", fromId: "a1", toType: "project", toId: "p1", kind: "counts_toward" }),
      link({ fromType: "action", fromId: "a2", toType: "project", toId: "p2", kind: "counts_toward" }),
      link({ fromType: "action", fromId: "a2", toType: "outcome", toId: "o1", kind: "counts_toward" }),
      link({ toId: "maths", status: "confirmed" }),
      link({ toId: "maths", status: "rejected" })
    ];
    const groups = groupSuggestedLinks(links, resolver.titleOf);
    expect(groups.map((group) => group.label)).toEqual([
      "Subject: Maths",
      "Subject: Meals",
      "Project: Drafting folio",
      "Project: Maths exam",
      "Other links"
    ]);
    expect(groups[0]!.links).toHaveLength(1);
  });

  it("orders a group's links newest first and returns nothing for no suggestions", () => {
    const old = link({ createdAt: "2026-09-01T00:00:00.000Z" });
    const recent = link({ fromId: "a2", createdAt: "2026-09-25T00:00:00.000Z" });
    expect(groupSuggestedLinks([old, recent], resolver.titleOf)[0]!.links).toEqual([recent, old]);
    expect(groupSuggestedLinks([], resolver.titleOf)).toEqual([]);
  });
});

describe("bulkConfirmGroups", () => {
  it("offers a bulk confirm only for a proposer and kind with several suggestions", () => {
    const links = [
      link({ fromId: "a1" }),
      link({ fromId: "a2" }),
      link({ fromId: "a3", proposer: "model:haiku" }),
      link({ fromId: "a4", kind: "prepares", toType: "project", toId: "p1" }),
      link({ fromId: "a5", status: "confirmed" })
    ];
    expect(bulkConfirmGroups(links)).toEqual([{ proposer: "rule:keywords", kind: "about", count: 2 }]);
  });
});

describe("counts and findings", () => {
  it("counts suggested links and open findings", () => {
    expect(openCount(null)).toBe(0);
    expect(
      openCount(
        planMap({
          links: [link(), link({ status: "confirmed" })],
          findings: [finding(), finding({ status: "dismissed" })]
        })
      )
    ).toBe(2);
  });

  it("describes suggested changes whatever their shape", () => {
    expect(describeSuggestedChange("Add an action")).toBe("Add an action");
    expect(describeSuggestedChange({ summary: "Link them" })).toBe("Link them");
    expect(describeSuggestedChange({ op: "x" })).toBe('{"op":"x"}');
    expect(describeSuggestedChange({ op: "x".repeat(300) }).length).toBeLessThanOrEqual(140);
  });
});

describe("switchRows", () => {
  it("lists the five switchable add-ons (no navigator), absent ones off", () => {
    const rows = switchRows(planMap({ switches: [{ addon: "nudge", mode: "shadow" }] }));
    expect(rows).toHaveLength(5);
    expect(rows.some((row) => (row.addon as string) === "navigator")).toBe(false);
    expect(rows.find((row) => row.addon === "nudge")?.mode).toBe("shadow");
    expect(rows.filter((row) => row.mode === "off")).toHaveLength(4);
    expect(switchRows(null).every((row) => row.mode === "off")).toBe(true);
  });

  it("reads a stored shadow of an off/on-only add-on as its effective mode", () => {
    const rows = switchRows(
      planMap({
        switches: [
          { addon: "jev_subjects", mode: "shadow" },
          { addon: "email_needs_reply", mode: "shadow" },
          { addon: "executor", mode: "shadow" }
        ]
      })
    );
    const mode = (addon: string) => rows.find((row) => row.addon === addon)?.mode;
    expect(mode("jev_subjects")).toBe("on");
    expect(mode("email_needs_reply")).toBe("off");
    expect(mode("executor")).toBe("shadow");
  });
});

describe("modeOptions", () => {
  it("offers only off and on to the off/on-only add-ons and all three to the rest", () => {
    for (const addon of ON_OFF_ONLY_ADDONS) expect(modeOptions(addon as SwitchableAddon)).toEqual(["off", "on"]);
    expect([...ON_OFF_ONLY_ADDONS].sort()).toEqual(["email_needs_reply", "jev_subjects"]);
    for (const addon of ["executor", "nudge", "capture_placement"] as const)
      expect(modeOptions(addon)).toEqual(["off", "shadow", "on"]);
  });

  it("describes every add-on, and the nudge says on changes no rankings yet", () => {
    for (const addon of SWITCHABLE_ADDONS) expect(ADDON_LABELS[addon].blurb.length).toBeGreaterThan(10);
    expect(ADDON_LABELS.nudge.blurb).toMatch(/does not change rankings yet/);
  });
});

describe("linksForItem", () => {
  const item = { type: "action", id: "a1" } as const;
  it("keeps confirmed and suggested links from either end, confirmed first", () => {
    const out = link({ status: "suggested" });
    const incoming = link({
      fromType: "project",
      fromId: "p1",
      toType: "action",
      toId: "a1",
      kind: "prepares",
      status: "confirmed"
    });
    const rejected = link({ status: "rejected" });
    const elsewhere = link({ fromId: "a9" });
    const views = linksForItem(planMap({ links: [out, rejected, elsewhere, incoming] }), item);
    expect(views.map((view) => [view.link.id, view.direction])).toEqual([
      [incoming.id, "in"],
      [out.id, "out"]
    ]);
    expect(describeItemLink(views[0]!, resolver.titleOf)).toBe("is prepared by Maths exam");
    expect(describeItemLink(views[1]!, resolver.titleOf)).toBe("is about Maths");
  });
});

describe("connection choices", () => {
  const candidates = connectionCandidates(titles, map);
  const action = { type: "action", id: "a1" } as const;

  it("offers subjects, work items and series rules, never a series' occurrences", () => {
    expect(candidates.filter((c) => c.type === "commitment").map((c) => c.id)).toEqual(["rule-squad", "c-once"]);
    expect(candidates.filter((c) => c.type === "subject").map((c) => c.title)).toEqual(["Maths", "Meals"]);
  });

  it("skips archived subjects", () => {
    const archived = planMap({ subjects: [{ id: "old", name: "Old", description: null, status: "archived" }] });
    expect(connectionCandidates(titles, archived).some((c) => c.type === "subject")).toBe(false);
  });

  it("filters candidates through validateLink: about reaches only subjects", () => {
    const about = RELATIONS[0]!;
    expect(candidatesFor(about, action, candidates, []).every((c) => c.type === "subject")).toBe(true);
  });

  it("never offers the item itself or a pair already linked", () => {
    const prepares = RELATIONS.find((r) => r.kind === "prepares" && r.direction === "out")!;
    const taken = link({ toType: "project", toId: "p1", kind: "prepares", status: "confirmed" });
    const choices = candidatesFor(prepares, action, candidates, [taken]);
    expect(choices.some((c) => c.type === "action" && c.id === "a1")).toBe(false);
    expect(choices.some((c) => c.type === "project" && c.id === "p1")).toBe(false);
    expect(choices.some((c) => c.type === "project" && c.id === "p2")).toBe(true);
    // A rejected pair may be offered again by hand.
    const rejected = link({ toType: "project", toId: "p1", kind: "prepares", status: "rejected" });
    expect(candidatesFor(prepares, action, candidates, [rejected]).some((c) => c.id === "p1")).toBe(true);
  });

  it("offers before only between projects and occurrence_of only for commitments", () => {
    const project = { type: "project", id: "p1" } as const;
    const kinds = (item: { type: "project" | "action" | "commitment"; id: string }) =>
      new Set(availableRelations(item, candidates, []).map((r) => r.kind));
    expect(kinds(project).has("before")).toBe(true);
    expect(kinds(action).has("before")).toBe(false);
    expect(kinds({ type: "commitment", id: "c-once" }).has("occurrence_of")).toBe(true);
    expect(kinds(action).has("occurrence_of")).toBe(false);
    expect(availableRelations(action, candidates, [])[0]!.kind).toBe("about");
  });

  it("builds the link input from either side", () => {
    const out = RELATIONS.find((r) => r.kind === "prepares" && r.direction === "out")!;
    const inward = RELATIONS.find((r) => r.kind === "prepares" && r.direction === "in")!;
    const other = { type: "project", id: "p1" } as const;
    expect(linkInputFor(out, action, other)).toEqual({
      kind: "prepares",
      fromType: "action",
      fromId: "a1",
      toType: "project",
      toId: "p1"
    });
    expect(linkInputFor(inward, action, other)).toMatchObject({ fromType: "project", fromId: "p1", toType: "action" });
  });

  it("links a series' rule rather than the occurrence", () => {
    expect(itemRefFor("commitment", "c-occ", "rule-squad")).toEqual({ type: "commitment", id: "rule-squad" });
    expect(itemRefFor("commitment", "c-once")).toEqual({ type: "commitment", id: "c-once" });
    expect(itemRefFor("action", "a1", "ignored")).toEqual({ type: "action", id: "a1" });
  });
});

describe("recentlyDecided", () => {
  const now = Date.parse("2026-09-25T00:00:00.000Z");
  const r = buildTitleResolver(titles, planMap());

  it("lists links and findings decided in the last 7 days, newest first, with their outcome", () => {
    const rows = recentlyDecided(
      {
        links: [
          link({ status: "confirmed", decidedAt: "2026-09-24T00:00:00.000Z" }),
          link({ status: "rejected", decidedAt: "2026-09-20T00:00:00.000Z" })
        ],
        findings: [finding({ status: "dismissed", decidedAt: "2026-09-24T12:00:00.000Z" })]
      },
      r.titleOf,
      now
    );
    expect(rows.map((row) => row.outcome)).toEqual(["dismissed", "confirmed", "rejected"]);
    expect(rows[1]!.title).toBe("Practice paper about Maths");
  });

  it("leaves out what is still waiting, what is older than a week and what was never decided", () => {
    const rows = recentlyDecided(
      {
        links: [
          link({ status: "suggested" }),
          link({ status: "confirmed", decidedAt: null }),
          link({ status: "confirmed", decidedAt: "2026-09-01T00:00:00.000Z" })
        ],
        findings: [finding({ status: "open" }), finding({ status: "accepted", decidedAt: "2026-08-01T00:00:00.000Z" })]
      },
      r.titleOf,
      now
    );
    expect(rows).toEqual([]);
    expect(recentlyDecided(null, r.titleOf, now)).toEqual([]);
  });
});
