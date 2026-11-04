import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { buildPlanIndex } from "../src/plan-map/derive.js";
import { navigate, resolveItem } from "../src/plan-map/navigate.js";
import type { StoredLinkSource } from "../src/plan-map/stored-links.js";
import type { StoredLink } from "../src/plan-map/model.js";
import { normaliseState } from "../src/client.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/** The fixture plus a second deliverable on the same source, a blocker and criterion, and a contact. */
function mapState(): Record<string, unknown> {
  const state = fixtureRawState();
  const deliverables = state.deliverables as Record<string, unknown>[];
  const chapter = deliverables[0] as Record<string, unknown>;
  chapter.sourceIds = ["source-brief"];
  chapter.criteria = [
    {
      id: "crit-cited",
      key: "cited",
      title: "All claims cited",
      required: true,
      state: "unsatisfied",
      stepIds: ["step-write"]
    }
  ];
  chapter.blockers = [
    {
      id: "block-supervisor",
      description: "Waiting on supervisor feedback",
      category: "waiting_on_someone",
      state: "open",
      stepIds: ["step-write"]
    }
  ];
  deliverables.push({
    ...chapter,
    id: "deliverable-abstract",
    title: "Abstract",
    sourceIds: ["source-brief"],
    criteria: [],
    blockers: [],
    steps: []
  });
  const conditions = state.conditionDefinitions as Record<string, unknown>[];
  conditions.push({ id: "contact-supervisor", name: "Dr Supervisor", kind: "contact" });
  const commitments = state.commitments as Record<string, unknown>[];
  commitments.push({
    id: "commitment-meeting",
    title: "Supervisor meeting",
    startsAt: "2026-09-04T10:00:00+10:00",
    endsAt: "2026-09-04T11:00:00+10:00",
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    contactId: "contact-supervisor",
    projectId: "project-thesis"
  });
  return state;
}

async function run(argv: string[], state: Record<string, unknown> = mapState(), storedLinks?: StoredLinkSource) {
  const calls: RecordedCall[] = [];
  const lines: string[] = [];
  let stderr = "";
  const exitCode = await runCli(["map", ...argv], {
    stdout: (text) => lines.push(text),
    stderr: (text) => {
      stderr += text;
    },
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    storedLinks,
    fetchImpl: fakeFetch({ "/api/state": { body: { state } } }, calls)
  });
  return { exitCode, text: lines.join("\n"), stderr, calls };
}

const index = () => buildPlanIndex(normaliseState(mapState(), () => undefined));
const handles = (list: { handle: string }[]) => list.map((entry) => entry.handle);

describe("map", () => {
  it("is read-only: GETs of the state and the stored links, and nothing else", async () => {
    const result = await run(["project:project-thesis"]);
    expect(result.exitCode).toBe(EXIT.ok);
    expect(result.calls.map((call) => `${call.method} ${call.path}`)).toEqual(["GET /api/state", "GET /api/plan-map"]);
  });

  it("reads stored links through the portal API by default, flagging suggested ones", async () => {
    const link = (id: string, toId: string, status: string) => ({
      id,
      fromType: "project",
      fromId: "project-thesis",
      toType: "action",
      toId,
      kind: "prepares",
      weight: null,
      status,
      proposer: "owner",
      evidence: ["same week"],
      createdAt: "2026-09-01T00:00:00.000Z",
      decidedAt: null,
      lastConfirmedAt: null
    });
    const links = [
      link("11111111-1111-4111-8111-111111111111", "action-weed", "confirmed"),
      link("22222222-2222-4222-8222-222222222222", "action-cite", "suggested"),
      link("33333333-3333-4333-8333-333333333333", "action-cite", "rejected"),
      { not: "a link" }
    ];
    const lines: string[] = [];
    const exitCode = await runCli(["map", "project:project-thesis", "--kinds", "prepares", "--suggested", "--json"], {
      stdout: (text) => lines.push(text),
      stderr: () => undefined,
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      fetchImpl: fakeFetch({ "/api/state": { body: { state: mapState() } }, "/api/plan-map": { body: { links } } })
    });
    expect(exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(lines.join("\n")) as {
      storedLinks: string;
      edges: { to: string; status?: string; origin: string }[];
    };
    expect(doc.storedLinks).toBe("available");
    const stored = doc.edges.filter((edge) => edge.origin === "stored");
    expect(stored.map((edge) => edge.to).sort()).toEqual(["action:action-cite", "action:action-weed"]);
    expect(stored.find((edge) => edge.to === "action:action-cite")?.status).toBe("suggested");
  });

  it("falls back to unavailable when the portal cannot answer for stored links", async () => {
    const result = await run(["project:project-thesis", "--json"]);
    expect((JSON.parse(result.text) as { storedLinks: string }).storedLinks).toBe("unavailable");
  });

  it("returns a project's tree neighbours with a card line each", async () => {
    const result = await run(["project:project-thesis", "--json"]);
    const doc = JSON.parse(result.text) as {
      root: { title: string };
      cards: { handle: string }[];
      storedLinks: string;
    };
    expect(doc.root.title).toBe("Thesis");
    expect(handles(doc.cards)).toEqual(
      expect.arrayContaining(["outcome:outcome-degree", "action:action-cite", "deliverable:deliverable-chapter"])
    );
    expect(doc.storedLinks).toBe("unavailable");
  });

  it("derives depends_on, criterion and blocker edges from the hard tables", () => {
    const result = navigate(index(), resolveItem(index(), "step:step-write"), {
      depth: 1,
      kinds: new Set(),
      budget: 2000,
      now: fixtureNow
    });
    const kinds = result.edges.map((edge) => `${edge.from} ${edge.kind} ${edge.to}`);
    expect(kinds).toContain("step:step-write depends_on step:step-outline");
    expect(kinds).toContain("step:step-write criterion criterion:crit-cited");
    expect(kinds).toContain("step:step-write blocker blocker:block-supervisor");
  });

  it("links items that share a source through a source hub, reachable at depth 2", () => {
    const result = navigate(index(), resolveItem(index(), "deliverable-chapter"), {
      depth: 2,
      kinds: new Set(["same_source"]),
      budget: 2000,
      now: fixtureNow
    });
    expect(handles(result.cards)).toEqual(
      expect.arrayContaining(["source:source-brief", "deliverable:deliverable-abstract"])
    );
  });

  it("links items at the same place and with the same contact", () => {
    const place = navigate(index(), resolveItem(index(), "place:ctx-gym"), {
      depth: 1,
      kinds: new Set(["same_place"]),
      budget: 2000,
      now: fixtureNow
    });
    expect(handles(place.cards)).toContain("commitment:commitment-gym");
    const contact = navigate(index(), resolveItem(index(), "contact:contact-supervisor"), {
      depth: 1,
      kinds: new Set(["same_contact"]),
      budget: 2000,
      now: fixtureNow
    });
    expect(handles(contact.cards)).toEqual(["commitment:commitment-meeting"]);
  });

  it("counts steps and open blockers on a card, computed from current rows", () => {
    const idx = index();
    const result = navigate(idx, resolveItem(idx, "deliverable-chapter"), {
      depth: 0,
      kinds: new Set(),
      budget: 2000,
      now: fixtureNow
    });
    expect(result.root).toMatchObject({ steps: 2, openBlockers: 1, parent: "Thesis" });
  });

  it("trims to the budget, keeping the root and nearer, open, dated neighbours first", () => {
    const idx = index();
    const full = navigate(idx, resolveItem(idx, "project-thesis"), {
      depth: 1,
      kinds: new Set(),
      budget: 5000,
      now: fixtureNow
    });
    const small = navigate(idx, resolveItem(idx, "project-thesis"), {
      depth: 1,
      kinds: new Set(),
      budget: 60,
      now: fixtureNow
    });
    expect(small.root.handle).toBe("project:project-thesis");
    expect(small.cards.length).toBeLessThan(full.cards.length);
    expect(small.omitted).toBe(full.cards.length - small.cards.length);
    const open = handles(full.cards.filter((card) => card.status !== "done"));
    const done = handles(full.cards.filter((card) => card.status === "done"));
    const order = handles(full.cards);
    for (const handle of done) for (const o of open) expect(order.indexOf(o)).toBeLessThan(order.indexOf(handle));
  });

  const stored: StoredLink[] = [
    { from: "action:action-cite", to: "action:action-weed", kind: "prepares", status: "confirmed" },
    {
      from: "action:action-cite",
      to: "commitment:commitment-gym",
      kind: "prepares",
      status: "suggested",
      evidence: ["same week"]
    },
    { from: "action:action-cite", to: "action:gone", kind: "prepares", status: "confirmed" }
  ];
  it("shows only confirmed stored links by default, suggested when asked, and skips links to missing items", () => {
    const idx = index();
    const options = { depth: 1, kinds: new Set(["prepares"]), budget: 2000, stored, now: fixtureNow };
    const confirmedOnly = navigate(idx, resolveItem(idx, "action-cite"), options);
    expect(handles(confirmedOnly.cards)).toEqual(["action:action-weed"]);
    const withSuggested = navigate(idx, resolveItem(idx, "action-cite"), { ...options, includeSuggested: true });
    expect(withSuggested.edges.find((edge) => edge.to === "commitment:commitment-gym")).toMatchObject({
      status: "suggested",
      origin: "stored",
      evidence: "same week"
    });
    expect(handles(withSuggested.cards)).not.toContain("action:gone");
  });

  it("resolves a title and refuses an ambiguous or unknown item", async () => {
    expect((await run(["Thesis"])).exitCode).toBe(EXIT.ok);
    expect((await run(["no-such-thing"])).exitCode).toBe(EXIT.notFound);
    expect((await run(["Gym"])).exitCode).toBe(EXIT.usage);
    expect((await run(["project-thesis", "--kinds", "nonsense"])).exitCode).toBe(EXIT.usage);
    expect((await run(["project-thesis", "--depth", "9"])).exitCode).toBe(EXIT.usage);
  });

  it("prints one card line per item and says stored links are unavailable", async () => {
    const result = await run(["deliverable-chapter"]);
    expect(result.text).toContain("deliverable:deliverable-chapter  Chapter 3 draft");
    expect(result.text).toContain("1 open blocker");
    expect(result.text).toContain("Stored links are not available yet");
  });

  it("gives a card the same counts whatever --kinds or --suggested show", () => {
    const idx = index();
    const base = { depth: 1, budget: 5000, now: fixtureNow, stored: [] as StoredLink[] };
    const root = resolveItem(idx, "deliverable-chapter");
    const all = navigate(idx, root, { ...base, kinds: new Set() }).root;
    expect(all.steps).toBe(2);
    expect(navigate(idx, root, { ...base, kinds: new Set(["depends_on"]) }).root).toEqual(all);
    const suggested = navigate(idx, root, {
      ...base,
      kinds: new Set(["prepares"]),
      includeSuggested: true,
      stored: [
        { from: "deliverable:deliverable-chapter", to: "action:action-weed", kind: "prepares", status: "suggested" }
      ]
    });
    // A suggested link is shown when asked, but never inflates the card's link count.
    expect(suggested.root.links).toBe(all.links);
  });

  it("ranks a neighbour by its best edge, so a confirmed stored link beats a duplicate derived one", () => {
    const idx = index();
    // action-cite and action-done are both children of project-thesis (derived), and both closed-or-open
    // differently; confirm a stored link to the one that would otherwise rank last, then squeeze the budget.
    const root = resolveItem(idx, "project-thesis");
    const options = { depth: 1, kinds: new Set<string>(), now: fixtureNow };
    const derivedOnly = navigate(idx, root, { ...options, budget: 5000 });
    const last = derivedOnly.cards.at(-1)!;
    const stored: StoredLink[] = [{ from: root.handle, to: last.handle, kind: "about", status: "confirmed" }];
    const withStored = navigate(idx, root, { ...options, budget: 5000, stored });
    expect(withStored.cards[0]?.handle).toBe(last.handle);
    // Grow the budget until exactly one neighbour fits: it must be the confirmed one.
    let one: string[] = [];
    for (let budget = 20; budget < 400 && one.length === 0; budget += 4)
      one = handles(navigate(idx, root, { ...options, budget, stored }).cards);
    expect(one).toEqual([last.handle]);
  });

  it("falls back to derived links when the stored link source fails, and drops rows with unknown kinds", async () => {
    const failing: StoredLinkSource = {
      available: true,
      read: async () => {
        throw new Error("relation plan_links does not exist");
      }
    };
    const result = await run(["project-thesis", "--json"], mapState(), failing);
    expect(result.exitCode).toBe(EXIT.ok);
    const doc = JSON.parse(result.text) as { storedLinks: string; storedLinksError: string; cards: unknown[] };
    expect(doc.storedLinks).toBe("error");
    expect(doc.storedLinksError).toContain("plan_links");
    expect(doc.cards.length).toBeGreaterThan(0);
    expect((await run(["project-thesis"], mapState(), failing)).text).toContain("Stored links could not be read");

    const junk: StoredLinkSource = {
      available: true,
      read: async () => [
        { from: "project:project-thesis", to: "action:action-weed", kind: "bogus", status: "confirmed" },
        { from: "project:project-thesis", to: "action:action-weed", kind: "about", status: "rejected" as never }
      ]
    };
    const filtered = JSON.parse(
      (await run(["project-thesis", "--kinds", "about", "--json"], mapState(), junk)).text
    ) as {
      edges: unknown[];
      storedLinks: string;
    };
    expect(filtered).toMatchObject({ edges: [], storedLinks: "available" });
  });

  it("reports a bad --depth or --budget as a positive whole number, not minutes", async () => {
    const result = await run(["project-thesis", "--budget", "-5"]);
    expect(result.exitCode).toBe(EXIT.usage);
    expect(result.stderr).toContain("positive whole number");
    expect(result.stderr).not.toContain("minutes");
  });
});
