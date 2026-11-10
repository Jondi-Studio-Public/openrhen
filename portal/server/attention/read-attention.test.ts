import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SCOPE_PRESETS,
  ATTENTION_KINDS,
  attentionCallProblem,
  factOpenItem,
  FEED_OWNS_DOCTOR_CHECKS,
  mcpManifestTool,
  scopeCovers,
  type AttentionItem,
  type CatchUpEntry,
  type DoctorItem,
  type DoctorReport
} from "@openrhen/contracts";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import type { CatchUpDue } from "@/server/persistence/postgres/catch-up";
import { readAttention, type AttentionRequest, type AttentionResponse } from "./read-attention";
import type { AttentionPulse, AttentionReaders, ProposalsRead } from "./readers";

/**
 * The feed's assembly over injected readers (the real readers are walked by the integration suite): per-scope kinds,
 * failure handling, the cursor rule and the wording guards.
 */
const NOW = new Date("2026-11-04T12:00:00.000Z");
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SENTINEL = "SENTINEL-91c2";
const sql = {} as PoolSql;

const preset = (name: string) => AGENT_SCOPE_PRESETS[name] as readonly string[];
const READ_ONLY = preset("read-only");
const SCRIBE = preset("scribe");
const ASSISTANT = preset("assistant");
const READ_PLAN_ONLY = ["read:plan"] as const;

const doctorItem = (check: DoctorItem["check"], over: Partial<DoctorItem> = {}): DoctorItem => ({
  id: `${check}:${SENTINEL}`,
  check,
  tier: "blocking",
  area: "integrations",
  title: `${SENTINEL} title`,
  why: `${SENTINEL} why`,
  handles: [],
  since: "2026-11-02T08:00:00.000Z",
  fix: { who: "person", question: `${SENTINEL} question` },
  ...over
});

const REPORT_ITEMS: DoctorItem[] = [
  doctorItem("sync_failing"),
  doctorItem("calendar_publish_failing", {
    area: "calendar",
    fix: { who: "agent", tool: "rhen_wake" }
  }),
  doctorItem("blocker_no_person", { area: "plan", fix: { who: "agent", tool: "rhen_save" } }),
  // Owned by status: dropped from the feed and from every count.
  doctorItem("stale_location", { area: "facts" }),
  doctorItem("no_estimate", { tier: "degrading", area: "plan" })
];

const report = (items: DoctorItem[] = REPORT_ITEMS): DoctorReport => ({
  generatedAt: NOW.toISOString(),
  healthy: items.length === 0,
  counts: {
    blocking: items.filter((i) => i.tier === "blocking").length,
    degrading: items.filter((i) => i.tier === "degrading").length,
    tidy: 0
  },
  byArea: {},
  items,
  notChecked: []
});

const checkInEntry = {
  id: `check-in:${uuid(900)}`,
  kind: "check_in",
  title: `${SENTINEL} directive`,
  plannedAt: "2026-11-04T09:00:00.000Z",
  question: `${SENTINEL} question`,
  verdicts: [],
  atRequired: [],
  localDate: null,
  projectId: null,
  version: 1
} as unknown as CatchUpEntry;

const dueNow: CatchUpDue = {
  due: true,
  lapsed: false,
  pulse: null,
  since: new Date("2026-11-02T00:00:00.000Z"),
  unsettled: 3
};

const quiet: CatchUpDue = { ...dueNow, due: false, unsettled: 0 };

const PULSE: AttentionPulse = {
  lapsed: false,
  view: {
    state: "on",
    reason: null,
    since: "2026-11-04T00:00:00.000Z",
    lastConfirmedAt: "2026-11-04T08:00:00.000Z",
    silenceUntil: null,
    reentry: { due: false, tier: "none", gapMinutes: 10, missing: [] }
  }
};

const proposalsRead = (over: Partial<ProposalsRead["outcomes"]> = {}, waiting: ProposalsRead["waiting"] = null) =>
  ({
    outcomes: {
      outcomes: [],
      staleCount: 0,
      queryNow: "2026-11-04T12:00:00.500Z",
      since: "2026-10-28T12:00:00.000Z",
      ...over
    },
    windowStart: "2026-11-03T12:00:00.000Z",
    waiting
  }) satisfies ProposalsRead;

const outcome = (n: number, status: "confirmed" | "rejected" | "expired" | "stale" = "rejected") => ({
  id: uuid(n),
  status,
  at: `2026-11-04T${String(10 + (n % 2)).padStart(2, "0")}:00:00.000Z`,
  kind: "entity_command",
  summary: `${SENTINEL} summary`,
  note: `${SENTINEL} note`,
  target: { entity: "project", id: uuid(700 + n) }
});

function makeReaders(over: Partial<AttentionReaders> = {}) {
  const readers = {
    userId: vi.fn(async () => "user-1"),
    doctor: vi.fn(async () => report()),
    entries: vi.fn(async () => [checkInEntry]),
    due: vi.fn(async () => dueNow),
    pulse: vi.fn(async () => PULSE),
    refusal: vi.fn(async () => Response.json({ code: "reentryRequired" }, { status: 428 })),
    proposals: vi.fn(async () => proposalsRead({ outcomes: [outcome(1), outcome(2, "stale")] })),
    decided: vi.fn(async () => 0),
    facts: vi.fn(async (): Promise<AttentionItem[]> => []),
    deadlines: vi.fn(async (): Promise<unknown> => null),
    ...over
  } satisfies AttentionReaders;
  return readers;
}

const run = async (request: Partial<AttentionRequest>, readers: AttentionReaders): Promise<AttentionResponse> => {
  const result = await readAttention(sql, { agent: "scribe", scopes: undefined, now: NOW, ...request }, readers);
  if (!("answer" in result)) throw new Error("expected an answer, got a re-entry refusal");
  return result.answer;
};

let errors: string[];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
});
afterEach(() => vi.restoreAllMocks());

const kinds = (answer: AttentionResponse) => answer.items.map((item) => item.kind);
const withoutQuoted = (answer: AttentionResponse) =>
  JSON.stringify(answer, (key, value) => (key === "quoted" ? undefined : value));

describe("readAttention: what it builds", () => {
  it("builds every kind the token can read, ordered, with the cursor after the items", async () => {
    const readers = makeReaders({
      proposals: vi.fn(async () =>
        proposalsRead(
          { outcomes: [outcome(1), outcome(2, "stale")] },
          { count: 2, oldestAt: "2026-10-30T00:00:00.000Z" }
        )
      )
    });
    const answer = await run({}, readers);
    expect(kinds(answer)).toEqual(
      expect.arrayContaining([
        "check_in_open",
        "catch_up_due",
        "health_blocking",
        "health_more",
        "proposal_decided",
        "proposals_waiting"
      ])
    );
    expect(answer.items.filter((item) => item.kind === "health_blocking")).toHaveLength(3);
    // The owned check is dropped, whatever its tier.
    expect(JSON.stringify(answer)).not.toContain("stale_location");
    expect(answer.cursor).toBe("2026-11-04T12:00:00.500Z");
    expect(Object.keys(answer).indexOf("cursor")).toBeGreaterThan(Object.keys(answer).indexOf("items"));
    expect(answer.sources).toEqual(
      expect.arrayContaining([
        { source: "catch-up", ok: true },
        { source: "check-in", ok: true },
        { source: "doctor", ok: true },
        { source: "pulse", ok: true },
        { source: "proposals", ok: true }
      ])
    );
    expect(answer.complete).toBe(true);
    expect(answer.empty).toBeUndefined();
  });

  it("adds a catch-up item only when the ledger is due, and a check-in item only when one is open", async () => {
    const answer = await run(
      {},
      makeReaders({
        due: vi.fn(async () => ({ ...dueNow, due: false })),
        entries: vi.fn(async () => [])
      })
    );
    expect(kinds(answer)).not.toContain("catch_up_due");
    expect(kinds(answer)).not.toContain("check_in_open");
    // Unsettled entries that are not yet due stay visible in the summary, counted from the one entries read.
    expect(answer.items.find((item) => item.kind === "health_more")?.why).toContain("4 data-health items");
  });

  it("answers the empty text, naming only what was read, when nothing needs attention", async () => {
    const answer = await run(
      {},
      makeReaders({
        doctor: vi.fn(async () => report([])),
        entries: vi.fn(async () => []),
        due: vi.fn(async () => quiet),
        proposals: vi.fn(async () => proposalsRead())
      })
    );
    expect(answer.items).toEqual([]);
    expect(answer.empty).toMatch(
      /^Nothing needs attention as of 12:00\. Checked: catch-up, check-in, doctor \(\d+ checks\), your proposals since 2026-10-28T12:00Z, open mail items, project deadlines\./
    );
    expect(answer.counts).toEqual({ now: 0, soon: 0, fyi: 0 });
  });

  it("reads the entries once and the check-in from them, never the stamping reader", async () => {
    const readers = makeReaders();
    await run({}, readers);
    expect(readers.entries).toHaveBeenCalledTimes(1);
    expect(readers.due).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readers.due).mock.calls[0]![2]).toEqual([checkInEntry]);
  });
});

describe("readAttention: scopes decide what is read", () => {
  it("a read:plan-only token reads no proposals, lists the kinds left out, and has no cursor without since", async () => {
    const readers = makeReaders();
    const answer = await run({ scopes: READ_PLAN_ONLY }, readers);
    expect(readers.proposals).not.toHaveBeenCalled();
    expect(kinds(answer)).not.toContain("proposal_decided");
    expect(kinds(answer)).not.toContain("proposals_waiting");
    expect(answer.notIncluded).toEqual([{ kinds: ["proposal_decided", "proposals_waiting"], scope: "read:proposals" }]);
    expect(answer.sources.map((s) => s.source)).not.toContain("proposals");
    expect(answer.cursor).toBeUndefined();
    expect(answer.since).toBeUndefined();
  });

  it("a read:plan-only token with since gets that since back as the cursor", async () => {
    const since = "2026-11-04T10:30:00.000Z";
    const answer = await run({ scopes: READ_PLAN_ONLY, since }, makeReaders());
    expect(answer.cursor).toBe(since);
    expect(answer.since).toBe(since);
  });

  it("the empty text of a token without read:proposals has no 'your proposals' clause", async () => {
    const answer = await run(
      { scopes: READ_PLAN_ONLY },
      makeReaders({
        doctor: vi.fn(async () => report([])),
        entries: vi.fn(async () => []),
        due: vi.fn(async () => quiet)
      })
    );
    expect(answer.empty).toBeDefined();
    expect(answer.empty).not.toContain("your proposals");
  });

  it.each([
    ["an environment token or a header-only name (undefined scopes)", undefined],
    ["a token holding read:proposals", READ_ONLY]
  ])("%s reads proposals", async (_name, scopes) => {
    const readers = makeReaders();
    const answer = await run({ scopes }, readers);
    expect(readers.proposals).toHaveBeenCalledTimes(1);
    expect(kinds(answer)).toContain("proposal_decided");
    expect(answer.notIncluded).toEqual([]);
  });

  it("an unscoped caller is allowed every known tool, so it gets pointers instead of owner pages", async () => {
    const answer = await run({ scopes: undefined }, makeReaders());
    expect(answer.items.find((item) => item.kind === "check_in_open")?.nextCall).toBeUndefined();
    expect(answer.items.find((item) => item.kind === "catch_up_due")?.nextCall).toMatchObject({
      tool: "rhen_catch_up"
    });
    for (const item of answer.items.filter((i) => i.kind === "health_blocking"))
      expect(item.nextCall).toMatchObject({ tool: "rhen_doctor" });
  });

  it("the owner view (no agent) reads no proposals and no pulse, and lists no proposal kind or missing scope", async () => {
    const readers = makeReaders();
    const answer = await run({ agent: null, scopes: undefined }, readers);
    expect(readers.proposals).not.toHaveBeenCalled();
    expect(readers.pulse).not.toHaveBeenCalled();
    expect(kinds(answer)).not.toContain("proposal_decided");
    expect(kinds(answer)).not.toContain("proposals_waiting");
    expect(answer.notIncluded).toEqual([]);
    expect(answer.sources.map((s) => s.source)).toEqual(["catch-up", "check-in", "doctor", "deadlines"]);
    expect(answer.cursor).toBeUndefined();
  });

  it("a read:proposals-only token cannot reach the route (read:plan is required) and agent-time holds no read scope", () => {
    expect(["read:proposals"].some((held) => scopeCovers(held, "read:plan"))).toBe(false);
    expect(preset("agent-time").some((held) => scopeCovers(held, "read:plan"))).toBe(false);
  });
});

describe("readAttention: the writable-scope rule over the presets", () => {
  const item = (answer: AttentionResponse, kind: string, check?: string) =>
    answer.items.find((i) => i.kind === kind && (check === undefined || i.id.startsWith(`health:${check}:`)));
  const isAsk = (call: AttentionItem["nextCall"]) => call !== undefined && "askOwner" in call;

  it("read-only is sent to the owner page for the check-in, the catch-up and every doctor fix", async () => {
    const answer = await run({ scopes: READ_ONLY }, makeReaders());
    expect(item(answer, "check_in_open")?.nextCall).toMatchObject({ ownerPage: "/" });
    expect(item(answer, "catch_up_due")?.nextCall).toMatchObject({ ownerPage: "/catch-up" });
    for (const check of ["calendar_publish_failing", "blocker_no_person"])
      expect(item(answer, "health_blocking", check)?.nextCall).toMatchObject({ ownerPage: "/doctor" });
  });

  it("scribe may record a catch-up and a save (both land as proposals), but not the check-in, a wake or a session", async () => {
    const answer = await run({ scopes: SCRIBE }, makeReaders());
    expect(item(answer, "check_in_open")?.nextCall).toMatchObject({ ownerPage: "/" });
    expect(item(answer, "catch_up_due")?.nextCall).toMatchObject({ tool: "rhen_catch_up" });
    expect(item(answer, "health_blocking", "calendar_publish_failing")?.nextCall).toMatchObject({
      ownerPage: "/doctor"
    });
    expect(item(answer, "health_blocking", "blocker_no_person")?.nextCall).toMatchObject({
      tool: "rhen_doctor",
      arguments: { tier: "blocking", area: "plan", limit: 0 }
    });
  });

  it("assistant records the check-in and the wake itself, so none of those gets an owner pointer", async () => {
    const answer = await run({ scopes: ASSISTANT }, makeReaders());
    expect(isAsk(item(answer, "check_in_open")?.nextCall)).toBe(false);
    expect(isAsk(item(answer, "catch_up_due")?.nextCall)).toBe(false);
    for (const check of ["calendar_publish_failing", "blocker_no_person"])
      expect(isAsk(item(answer, "health_blocking", check)?.nextCall)).toBe(false);
  });

  it("scribe's proposal outcome offers the re-make, and a read-only token is told it cannot", async () => {
    const readers = makeReaders({
      proposals: vi.fn(async () => proposalsRead({ outcomes: [outcome(2, "stale")], staleCount: 1 }))
    });
    const scribe = await run({ scopes: SCRIBE }, readers);
    expect(scribe.items.find((i) => i.kind === "proposal_decided")?.why).toContain("the same way you made it before");
    const readOnly = await run({ scopes: READ_ONLY }, readers);
    const stale = readOnly.items.find((i) => i.kind === "proposal_decided")!;
    expect(stale.why).toContain("This token cannot make the change again");
    expect(stale.nextCall).toBeUndefined();
  });
});

describe("readAttention: wording and pointers", () => {
  const callsOf = (answer: AttentionResponse) =>
    answer.items.flatMap((item) => [
      ...(item.nextCall && "tool" in item.nextCall ? [item.nextCall] : []),
      ...(item.source ? [item.source] : [])
    ]);

  it.each([
    ["unscoped", undefined],
    ["read-only", READ_ONLY],
    ["scribe", SCRIBE],
    ["assistant", ASSISTANT]
  ])("%s: every tool named is served, and none is the feed itself", async (_name, scopes) => {
    const readers = makeReaders({
      proposals: vi.fn(async () =>
        proposalsRead(
          { outcomes: [outcome(1), outcome(2, "stale"), outcome(3, "confirmed"), outcome(4, "expired")] },
          { count: 1, oldestAt: "2026-10-30T00:00:00.000Z", expiringAt: "2026-11-05T00:00:00.000Z" }
        )
      )
    });
    const answer = await run({ scopes }, readers);
    const names = JSON.stringify(answer).match(/rhen_[a-z_]+/g) ?? [];
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) {
      expect(mcpManifestTool(name), name).toBeDefined();
      expect(name).not.toBe(["rhen", "attention"].join("_"));
    }
    // A step to follow never names status; where to read more may (the check-in's source is full status).
    for (const item of answer.items)
      if (item.nextCall && "tool" in item.nextCall) expect(item.nextCall.tool).not.toBe("rhen_status");
    for (const call of callsOf(answer))
      expect(attentionCallProblem(call, scopes, { allowStatus: true }), `${call.tool}`).toBeUndefined();
  });

  it("the empty text names only served tools and never the feed or status", async () => {
    const answer = await run(
      {},
      makeReaders({
        doctor: vi.fn(async () => report([])),
        entries: vi.fn(async () => []),
        due: vi.fn(async () => quiet),
        proposals: vi.fn(async () => proposalsRead())
      })
    );
    expect(answer.empty).toBeDefined();
    for (const name of answer.empty!.match(/rhen_[a-z_]+/g) ?? []) expect(mcpManifestTool(name)).toBeDefined();
    expect(answer.empty).not.toContain("rhen_status");
    expect(answer.empty).not.toContain(["rhen", "attention"].join("_"));
  });

  it("every owner item and every askOwner carries the owner-present clause", async () => {
    const answer = await run(
      { scopes: READ_ONLY },
      makeReaders({
        proposals: vi.fn(async () =>
          proposalsRead({}, { count: 1, oldestAt: "2026-10-30T00:00:00.000Z", expiringAt: "2026-11-05T00:00:00.000Z" })
        )
      })
    );
    const owner = answer.items.filter((i) => i.who === "owner" || (i.nextCall && "askOwner" in i.nextCall));
    expect(owner.length).toBeGreaterThan(3);
    for (const i of owner) expect(i.why.toLowerCase(), i.id).toContain("only while the owner is in this conversation");
  });

  it("outside text appears only under quoted", async () => {
    const answer = await run({}, makeReaders());
    expect(withoutQuoted(answer)).not.toContain(SENTINEL);
    expect(JSON.stringify(answer)).toContain(SENTINEL);
  });
});

describe("readAttention: failure", () => {
  it("a failing source becomes source_unavailable, is logged by name and class only, and leaks nothing", async () => {
    const boom = () => Promise.reject(new TypeError(`${SENTINEL} an imported title`));
    const readers = makeReaders({
      doctor: vi.fn(boom),
      entries: vi.fn(boom),
      pulse: vi.fn(boom),
      proposals: vi.fn(boom)
    });
    const answer = await run({}, readers);
    const unavailable = answer.items.filter((i) => i.kind === "source_unavailable");
    expect(unavailable.map((i) => i.id).sort()).toEqual([
      "source_unavailable:catch-up",
      "source_unavailable:check-in",
      "source_unavailable:doctor",
      "source_unavailable:proposals",
      "source_unavailable:pulse"
    ]);
    expect(answer.complete).toBe(false);
    expect(answer.empty).toBeUndefined();
    for (const i of unavailable) expect(i.nextCall).toBeUndefined();
    expect(JSON.stringify(answer)).not.toContain(SENTINEL);
    expect(errors.length).toBeGreaterThanOrEqual(5);
    expect(errors.join("\n")).not.toContain(SENTINEL);
    expect(errors.join("\n")).toContain("TypeError");
    expect(errors.join("\n")).toContain('"source":"doctor"');
  });

  it("the source_unavailable text names no feed tool and says to retry this same tool", async () => {
    const answer = await run({}, makeReaders({ doctor: vi.fn(() => Promise.reject(new Error("x"))) }));
    const item = answer.items.find((i) => i.id === "source_unavailable:doctor")!;
    expect(item.why).toContain("Call this same tool once more");
    expect(item.why).not.toContain(["rhen", "attention"].join("_"));
  });

  it("when the outcome query throws the cursor is the since sent, and absent without one", async () => {
    const readers = makeReaders({ proposals: vi.fn(() => Promise.reject(new Error("expireOld failed"))) });
    const since = "2026-11-04T09:15:00.000Z";
    const withSince = await run({ since }, readers);
    expect(withSince.cursor).toBe(since);
    expect(withSince.items.map((i) => i.id)).toContain("source_unavailable:proposals");
    const without = await run({}, readers);
    expect(without.cursor).toBeUndefined();
    // Never generatedAt: a cursor from the clock would move past outcomes this answer never delivered.
    expect(withSince.cursor).not.toBe(withSince.generatedAt);
  });

  it("an unreadable pulse lists source_unavailable with no nextCall and the right text for the token", async () => {
    const readers = makeReaders({ pulse: vi.fn(() => Promise.reject(new Error("pulse down"))) });
    const unscoped = await run({ scopes: undefined }, readers);
    const first = unscoped.items.find((i) => i.id === "source_unavailable:pulse")!;
    expect(first.nextCall).toBeUndefined();
    expect(first.why).toContain("call rhen_reenter");
    const scribe = await run({ scopes: SCRIBE }, readers);
    const second = scribe.items.find((i) => i.id === "source_unavailable:pulse")!;
    expect(second.why).toContain("this token cannot apply re-entry");
    expect(second.why).toContain("only while the owner is in this conversation");
    expect(unscoped.complete).toBe(false);
  });

  it("a pulse that lapses after the gate answers the gate's refusal, not a feed", async () => {
    const lapsed = { ...PULSE, lapsed: true };
    const readers = makeReaders({ pulse: vi.fn(async () => lapsed) });
    const result = await readAttention(sql, { agent: "scribe", scopes: undefined, now: NOW }, readers);
    expect("lapsed" in result).toBe(true);
    if ("lapsed" in result) expect(result.lapsed.status).toBe(428);
    expect(readers.refusal).toHaveBeenCalledWith(lapsed);
  });

  it("a pulse the gate would not call lapsed (never confirmed) answers a feed", async () => {
    // `lapsed` is the gate's own view and already includes `everConfirmed`.
    const answer = await run({}, makeReaders({ pulse: vi.fn(async () => ({ ...PULSE, lapsed: false })) }));
    expect(answer.items.length).toBeGreaterThan(0);
  });

  it("an unmapped doctor check is listed, marked incomplete, logged through redact, and is not a failed source", async () => {
    const odd = doctorItem("sync_failing", { id: "odd:1", check: "x_publish_failing" as never });
    const answer = await run({}, makeReaders({ doctor: vi.fn(async () => report([odd])) }));
    expect(answer.items.some((i) => i.id.startsWith("health:other:"))).toBe(true);
    expect(answer.complete).toBe(false);
    expect(answer.sources).toContainEqual({ source: "doctor-mapping", ok: false });
    expect(answer.items.some((i) => i.kind === "source_unavailable")).toBe(false);
    expect(errors.join("\n")).toContain("outside the enum");
  });
});

describe("readAttention: since", () => {
  const readers = () =>
    makeReaders({ proposals: vi.fn(async () => proposalsRead({ since: "2026-10-28T12:00:00.000Z" })) });

  it("a since older than 7 days is moved to the window and the answer says where older outcomes are", async () => {
    const answer = await run({ scopes: READ_PLAN_ONLY, since: "2026-10-01T00:00:00.000Z" }, readers());
    expect(answer.since).toBe("2026-10-28T12:00:00.000Z");
    expect(answer.cursor).toBe("2026-10-28T12:00:00.000Z");
    expect(answer.sinceNote).toContain("rhen_proposals and rhen_changes");
  });

  it("a future since is moved to now", async () => {
    const answer = await run({ scopes: READ_PLAN_ONLY, since: "2026-12-01T00:00:00.000Z" }, readers());
    expect(answer.since).toBe(NOW.toISOString());
    expect(answer.sinceNote).toContain("future");
  });

  it("says nothing when since is inside the window", async () => {
    const answer = await run({ scopes: READ_PLAN_ONLY, since: "2026-11-03T00:00:00.000Z" }, readers());
    expect(answer.sinceNote).toBeUndefined();
  });
});

describe("readAttention: sanity of the fixtures", () => {
  it("the owned-check list still contains the fixture's dropped check", () => {
    expect(FEED_OWNS_DOCTOR_CHECKS).toContain("stale_location");
  });
});

describe("readAttention: open mail facts", () => {
  const factItems = (count: number, quoteSentinel = SENTINEL): AttentionItem[] =>
    Array.from({ length: count }, (_, n) =>
      factOpenItem({
        factId: String(n).padStart(40, "d"),
        factType: "ask",
        direction: "in",
        at: "2026-11-04T10:00:00.000Z",
        quote: `${quoteSentinel} ${n}`,
        held: undefined,
        generatedAt: NOW.toISOString()
      })!
    );

  it("lists them, counts them soon or fyi (never now), and names the source as read", async () => {
    const readers = makeReaders({ facts: vi.fn(async () => factItems(2)) });
    const answer = await run({ scopes: READ_PLAN_ONLY }, readers);
    expect(readers.facts).toHaveBeenCalledWith(NOW, READ_PLAN_ONLY, { quotes: true });
    expect(answer.items.filter((i) => i.kind === "fact_open")).toHaveLength(2);
    const base = await run({ scopes: READ_PLAN_ONLY }, makeReaders());
    expect(answer.counts.now).toBe(base.counts.now);
    expect(answer.counts.soon).toBe(base.counts.soon + 2);
    expect(answer.sources).toContainEqual({ source: "facts", ok: true });
  });

  it("quoted mail text stays in quoted and out of every server string", async () => {
    const readers = makeReaders({ facts: vi.fn(async () => factItems(1)) });
    const answer = await run({}, readers);
    const fact = answer.items.find((i) => i.kind === "fact_open")!;
    expect(fact.quoted?.summary).toContain(SENTINEL);
    expect(JSON.stringify({ ...fact, quoted: undefined })).not.toContain(SENTINEL);
  });

  it("a token without read:plan reads no facts and the answer says which kind and scope it left out", async () => {
    const readers = makeReaders();
    const answer = await run({ scopes: ["read:proposals"] }, readers);
    expect(readers.facts).not.toHaveBeenCalled();
    expect(answer.notIncluded).toContainEqual({ kinds: ["fact_open"], scope: "read:plan" });
    expect(answer.sources.map((s) => s.source)).not.toContain("facts");
  });

  it("the owner view reads no mail facts and does not claim to have", async () => {
    const readers = makeReaders();
    const answer = await run({ agent: null }, readers);
    expect(readers.facts).not.toHaveBeenCalled();
    expect(answer.notIncluded).toEqual([]);
  });

  it("a facts read that fails is one unavailable item and an incomplete answer, with nothing from the error", async () => {
    const readers = makeReaders({ facts: vi.fn(() => Promise.reject(new Error("FACTSENT boom"))) as never });
    const answer = await run({}, readers);
    expect(answer.complete).toBe(false);
    expect(answer.sources).toContainEqual({ source: "facts", ok: false });
    const lost = answer.items.find((i) => i.id === "source_unavailable:facts")!;
    // An optional source: its failure is shown, but it adds nothing to counts.now.
    expect(lost.urgency).toBe("soon");
    const base = await run({}, makeReaders());
    expect(answer.counts.now).toBe(base.counts.now);
    expect(JSON.stringify(answer)).not.toContain("FACTSENT");
  });

  it("the empty text names the mail only when it was read, and never claims nothing without it", async () => {
    const quietReaders = (over: Partial<AttentionReaders>) =>
      makeReaders({
        doctor: vi.fn(async () => report([])),
        entries: vi.fn(async () => []),
        due: vi.fn(async () => quiet),
        proposals: vi.fn(async () => proposalsRead()),
        ...over
      });
    const read = await run({}, quietReaders({}));
    expect(read.empty).toContain("open mail items");
    const failed = await run({}, quietReaders({ facts: vi.fn(() => Promise.reject(new Error("x"))) as never }));
    expect(failed.empty).toBeUndefined();
    const left = await run({ scopes: ["read:proposals"] }, quietReaders({}));
    expect(left.empty).not.toContain("mail");
  });
});

describe("readAttention: deadlines at risk", () => {
  const outlook = {
    projects: [
      {
        projectId: uuid(801),
        title: `${SENTINEL} Tax return`,
        verdict: "behind",
        deadlineAt: "2026-11-10T09:00:00.000Z",
        slackMinutes: -90,
        suggestion: "Start by 12:20 PM or this deadline becomes unreachable."
      },
      {
        projectId: uuid(802),
        title: "Tight one",
        verdict: "tight",
        deadlineAt: "2026-11-12T09:00:00.000Z",
        slackMinutes: 10
      },
      { projectId: uuid(803), title: "Fine", verdict: "ok", deadlineAt: null, slackMinutes: 500 },
      {
        projectId: uuid(804),
        title: "Gone by",
        verdict: "overdue",
        deadlineAt: "2026-11-01T09:00:00.000Z",
        slackMinutes: -30,
        suggestion: null
      }
    ]
  };

  it("lists one soon item per behind or overdue project, never tight or ok, with the title only quoted", async () => {
    const answer = await run({}, makeReaders({ deadlines: vi.fn(async () => outlook) }));
    const items = answer.items.filter((item) => item.kind === "deadline_at_risk");
    expect(items.map((item) => item.id)).toEqual([`deadline_at_risk:${uuid(804)}`, `deadline_at_risk:${uuid(801)}`]);
    for (const item of items) expect(item.urgency).toBe("soon");
    const behind = items.find((item) => item.id.endsWith(String(uuid(801))))!;
    expect(behind.quoted?.title).toContain("Tax return");
    expect(behind.why).toContain("1h 30m short");
    expect(behind.why).toContain("Start by 12:20 PM or this deadline becomes unreachable.");
    expect(behind.why).not.toContain(SENTINEL);
    expect(answer.sources).toContainEqual({ source: "deadlines", ok: true });
  });

  it("does not move counts.now, and the item vanishes once the project has recovered", async () => {
    const base = await run({}, makeReaders());
    const risk = await run({}, makeReaders({ deadlines: vi.fn(async () => outlook) }));
    expect(risk.counts.now).toBe(base.counts.now);
    expect(risk.counts.soon).toBe(base.counts.soon + 2);
    const recovered = await run(
      {},
      makeReaders({ deadlines: vi.fn(async () => ({ projects: [{ ...outlook.projects[0], verdict: "ok" }] })) })
    );
    expect(kinds(recovered)).not.toContain("deadline_at_risk");
  });

  it("lists nothing for a plan stored before the outlook existed", async () => {
    for (const stored of [null, undefined, {}, "x", { projects: "x" }]) {
      const answer = await run({}, makeReaders({ deadlines: vi.fn(async () => stored) }));
      expect(kinds(answer)).not.toContain("deadline_at_risk");
      expect(answer.sources).toContainEqual({ source: "deadlines", ok: true });
    }
  });

  it("ranks the item after blocking health items and before source_unavailable and proposals", async () => {
    const answer = await run(
      {},
      makeReaders({
        deadlines: vi.fn(async () => outlook),
        facts: vi.fn(() => Promise.reject(new Error("x"))) as never
      })
    );
    const order = answer.items.map((item) => item.kind);
    expect(order).toContain("health_blocking");
    expect(order).toContain("source_unavailable");
    expect(order).toContain("deadline_at_risk");
    // urgency orders first, so compare ranks inside one urgency by listing the contract's kind order
    const rank = (kind: (typeof order)[number]) => ATTENTION_KINDS.indexOf(kind);
    expect(rank("deadline_at_risk")).toBe(rank("health_blocking") + 1);
    const soon = answer.items.filter((item) => item.urgency === "soon").map((item) => item.kind);
    expect(soon.indexOf("deadline_at_risk")).toBeLessThan(soon.indexOf("source_unavailable"));
    expect(soon.indexOf("deadline_at_risk")).toBeLessThan(soon.indexOf("proposal_decided"));
  });

  it("is listed in the owner view, and a token without read:plan gets a notIncluded entry instead", async () => {
    const owner = await run({ agent: null }, makeReaders({ deadlines: vi.fn(async () => outlook) }));
    expect(kinds(owner)).toContain("deadline_at_risk");
    const readers = makeReaders({ deadlines: vi.fn(async () => outlook) });
    const blind = await run({ scopes: ["read:proposals"] }, readers);
    expect(readers.deadlines).not.toHaveBeenCalled();
    expect(kinds(blind)).not.toContain("deadline_at_risk");
    expect(blind.notIncluded).toContainEqual({ kinds: ["deadline_at_risk"], scope: "read:plan" });
  });

  it("a failed read is one soon unavailable item and an incomplete answer, with nothing from the error", async () => {
    const answer = await run(
      {},
      makeReaders({ deadlines: vi.fn(() => Promise.reject(new Error("DLSENT boom"))) as never })
    );
    expect(answer.complete).toBe(false);
    expect(answer.sources).toContainEqual({ source: "deadlines", ok: false });
    const lost = answer.items.find((item) => item.id === "source_unavailable:deadlines")!;
    expect(lost.urgency).toBe("soon");
    expect(JSON.stringify(answer)).not.toContain("DLSENT");
  });
});
