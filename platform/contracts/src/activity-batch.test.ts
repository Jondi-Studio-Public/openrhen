import { describe, expect, it } from "vitest";
import { applyCoverageRule, judgeActivityEvents, validateActivityBatch } from "./activity-batch.js";
import {
  ACTIVITY_MESSAGE_FAMILY,
  ACTIVITY_SOURCES,
  coverageKey,
  heartbeatKey,
  validateActivityEvent,
  type ActivitySourceEntry
} from "./activity-events.js";

const now = new Date("2026-11-07T12:00:00.000Z");

const ledger: ActivitySourceEntry = {
  schemaVersion: 1,
  kinds: ["debit"],
  availability: {
    delivery: "periodic",
    origin: "account",
    feeds: [{ signal: "spend", tier: "periodic", kinds: ["debit"], weight: 0.7, complete: true }],
    recoveryHint: "Run the statement poll again."
  }
};
const stream: ActivitySourceEntry = {
  schemaVersion: 1,
  kinds: ["ping"],
  availability: {
    delivery: "live",
    origin: "phone",
    feeds: [{ signal: "position", tier: "live", kinds: ["ping"], weight: 0.8 }],
    recoveryHint: "Open the app."
  }
};
/** The one core source that declares availability with no feeds: the message collector that reports liveness and coverage. */
const collector = Object.keys(ACTIVITY_SOURCES).find(
  (name) => ACTIVITY_SOURCES[name]!.availability?.feeds.length === 0
)!;
const chat: ActivitySourceEntry = { schemaVersion: 1, kinds: ["message"], family: ACTIVITY_MESSAGE_FAMILY };
const registry = { ...ACTIVITY_SOURCES, ledger, stream, chat };

const cov = (extra: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) => {
  const start = (extra.start as string | undefined) ?? "2026-11-06T00:00:00Z";
  const end = (extra.end as string | undefined) ?? "2026-11-07T00:00:00Z";
  const rev = attrs.rev as number | undefined;
  const scope = attrs.scope as string | undefined;
  return {
    id: coverageKey(scope, new Date(start), new Date(end), rev),
    source: "ledger",
    kind: "coverage",
    start,
    end,
    attrs: { complete: true, ...attrs },
    ...extra
  };
};
const hb = (status: "ok" | "error", start = "2026-11-07T11:30:00Z", device?: string, extra = {}) => ({
  id: heartbeatKey(device, new Date(start), status),
  source: "stream",
  kind: "heartbeat",
  start,
  attrs: { status },
  ...extra
});
const body = (events: unknown[], extra: Record<string, unknown> = {}) => ({ schema: 1, events, ...extra });
const reasonOf = (raw: unknown, device?: string, live = true) => {
  const v = validateActivityEvent(raw, now, { registry, device, live });
  return v.ok ? null : v.reason;
};

describe("coverage rows", () => {
  it("accepts a canonical window and gives Z and +00:00 the same key", () => {
    const z = validateActivityEvent(cov(), now, { registry });
    expect(z.ok).toBe(true);
    const offset = cov({ start: "2026-11-06T00:00:00+00:00", end: "2026-11-07T00:00:00.000+00:00" });
    expect(offset.id).toBe("cov:_:2026-11-06T00:00:00.000Z:2026-11-07T00:00:00.000Z");
    expect(reasonOf(offset)).toBeNull();
  });

  it("rejects a key mismatch and shows the expected key", () => {
    expect(reasonOf(cov({ id: "cov:_:2026-11-06T00:00:00Z:2026-11-07T00:00:00Z" }))).toContain(
      'must be "cov:_:2026-11-06T00:00:00.000Z:2026-11-07T00:00:00.000Z"'
    );
  });

  it("puts scope and rev in the key", () => {
    const row = cov({}, { scope: "a1", rev: 2 });
    expect(row.id).toBe("cov:a1:2026-11-06T00:00:00.000Z:2026-11-07T00:00:00.000Z:r2");
    expect(reasonOf(row)).toBeNull();
    expect(reasonOf({ ...row, id: coverageKey("a1", new Date(row.start), new Date(row.end)) })).toContain(":r2");
    expect(reasonOf(cov({}, { rev: 0 }))).toContain("attrs.rev");
    expect(reasonOf(cov({}, { rev: 1.5 }))).toContain("attrs.rev");
  });

  it("enforces scope when the family needs one, and its length", () => {
    const options = { registry, scopeRequired: (s: string) => s === "ledger" };
    expect(validateActivityEvent(cov(), now, options)).toMatchObject({ ok: false });
    expect(validateActivityEvent(cov({}, { scope: "a1" }), now, options).ok).toBe(true);
    expect(reasonOf(cov({ id: "x" }, { scope: "s".repeat(129) }))).toContain("attrs.scope");
  });

  it("needs complete true, no stray attrs and no content", () => {
    expect(reasonOf(cov({ attrs: { complete: false } }))).toContain("attrs.complete");
    expect(reasonOf(cov({ attrs: { complete: true, extra: 1 } }))).toContain("Allowed: complete, scope, rev");
    expect(reasonOf(cov({ content: "x" }))).toContain("no content");
  });

  it("is refused on a source with no complete feed or no availability", () => {
    expect(reasonOf(cov({ source: "stream" }))).toContain("complete (ledger) feed");
    expect(reasonOf(cov({ source: "rhen-watch" }))).toContain("complete (ledger) feed");
    expect(reasonOf(cov({ source: "rhen-watch" }))).toContain('Post an event of kind "foreground" instead');
  });

  it("is accepted on the collector source (availability, no feeds) and on a message-family source", () => {
    expect(reasonOf(cov({ source: collector }, { scope: "inbox" }))).toBeNull();
    expect(reasonOf(cov({ source: collector }))).toBeNull();
    expect(reasonOf(cov({ source: "chat" }, { scope: "room-1" }))).toBeNull();
  });

  it("bounds the window: needs an end, order, 31 days, future end, 1990 floor, 400-day live limit", () => {
    expect(reasonOf({ ...cov(), end: undefined })).toContain("needs an end");
    expect(reasonOf(cov({ end: "2026-11-06T00:00:00Z" }))).toContain("must be after start");
    const long = cov({ start: "2026-09-01T00:00:00Z", end: "2026-10-03T00:00:00Z" });
    expect(reasonOf(long)).toContain("longer than 31 days");
    expect(reasonOf(cov({ start: "2026-10-03T00:00:00Z", end: "2026-11-03T00:00:00Z" }))).toBeNull();
    expect(reasonOf(cov({ start: "2026-11-06T12:00:00Z", end: "2026-11-07T12:06:00Z" }))).toContain("in the future");
    expect(reasonOf(cov({ start: "2026-11-06T12:00:00Z", end: "2026-11-07T12:04:59Z" }))).toBeNull();
    expect(reasonOf(cov({ start: "1989-12-20T00:00:00Z", end: "1989-12-21T00:00:00Z" }))).toContain(
      "must be after 1990"
    );
    const old = cov({ start: "2025-01-01T00:00:00Z", end: "2025-01-31T00:00:00Z" });
    expect(reasonOf(old)).toContain("400 days");
    expect(reasonOf(old, undefined, false)).toBeNull();
  });
});

describe("heartbeats", () => {
  it("accepts ok and error, with a device in the key", () => {
    expect(reasonOf(hb("ok"))).toBeNull();
    expect(reasonOf(hb("ok", "2026-11-07T11:30:00Z", "phone-1"), "phone-1")).toBeNull();
    expect(reasonOf(hb("ok", "2026-11-07T11:30:00Z", "phone-1"), "phone-2")).toContain("hb:phone-2:2026-11-07T11:ok");
  });

  it("gives an error heartbeat after an ok one in the same hour a different key", () => {
    const ok = hb("ok", "2026-11-07T11:05:00Z");
    const error = hb("error", "2026-11-07T11:40:00Z", undefined, { attrs: { status: "error", error: "bad token" } });
    expect(ok.id).toBe("hb:_:2026-11-07T11:ok");
    expect(error.id).toBe("hb:_:2026-11-07T11:error");
    expect(hb("ok", "2026-11-07T11:50:00Z").id).toBe(ok.id);
    expect(reasonOf(error)).toBeNull();
  });

  it("rejects a future heartbeat, a bad status, long error text, stray attrs and a wrong key", () => {
    expect(reasonOf(hb("ok", "2026-11-07T12:06:00Z"))).toContain("in the future");
    expect(reasonOf(hb("ok", "2026-11-07T12:04:00Z"))).toBeNull();
    expect(reasonOf(hb("ok", undefined, undefined, { attrs: { status: "up" } }))).toContain("attrs.status");
    expect(
      reasonOf(hb("error", undefined, undefined, { attrs: { status: "error", error: "e".repeat(201) } }))
    ).toContain("attrs.error");
    expect(reasonOf(hb("ok", undefined, undefined, { attrs: { status: "ok", note: 1 } }))).toContain(
      "Allowed: status, error"
    );
    expect(reasonOf(hb("ok", undefined, undefined, { id: "mine" }))).toContain('must be "hb:_:2026-11-07T11:ok"');
  });

  it("is refused on an import-only source and on a legacy source", () => {
    const importOnly = {
      ...registry,
      files: { ...stream, availability: { ...stream.availability!, delivery: "import" as const } }
    };
    const v = validateActivityEvent({ ...hb("ok"), source: "files" }, now, { registry: importOnly });
    expect(v).toMatchObject({ ok: false });
    const reason = reasonOf({ ...hb("ok"), source: "rhen-watch" });
    expect(reason).toContain("live or periodically");
    expect(reason).toContain('Post an event of kind "foreground" instead');
  });

  it("is accepted on the collector source and on a message-family source", () => {
    expect(reasonOf({ ...hb("ok"), source: collector })).toBeNull();
    expect(reasonOf({ ...hb("ok"), source: "chat" })).toBeNull();
  });

  it("names the batch device when the key is wrong", () => {
    expect(reasonOf(hb("ok", "2026-11-07T11:30:00Z", "phone-1"))).toContain('none sent, so "_"');
    expect(reasonOf(hb("ok", "2026-11-07T11:30:00Z", "phone-1"), "phone-2")).toContain('the batch device ("phone-2")');
  });
});

describe("applyCoverageRule", () => {
  const accepted = (source: string, kind = "debit") => ({
    verdict: validateActivityEvent(
      kind === "coverage" ? cov({ source }) : { id: "e", source, kind, start: "2026-11-07T10:00:00Z" },
      now,
      { registry }
    ),
    source
  });
  const rejectedRow = (source: string | null) => ({ verdict: { ok: false as const, reason: "bad row" }, source });

  it("refuses coverage when another event of the same source was rejected, whatever its scope", () => {
    const out = applyCoverageRule([accepted("ledger"), rejectedRow("ledger"), accepted("ledger", "coverage")]);
    expect(out[0]!.ok).toBe(true);
    expect(out[2]).toMatchObject({ ok: false });
    expect((out[2] as { reason: string }).reason).toContain(
      "coverage refused: event #1 of ledger was rejected (bad row)"
    );
  });

  it("refuses coverage when a rejected event's source could not be read", () => {
    const out = applyCoverageRule([rejectedRow(null), accepted("ledger", "coverage")]);
    expect((out[1] as { reason: string }).reason).toContain("its source could not be read");
  });

  it("leaves coverage alone when only another source had a rejection", () => {
    const out = applyCoverageRule([rejectedRow("stream"), accepted("ledger", "coverage")]);
    expect(out[1]!.ok).toBe(true);
  });

  it("leaves accepted data rows and the rejected verdicts unchanged", () => {
    const input = [accepted("ledger"), rejectedRow("ledger")];
    expect(applyCoverageRule(input)).toEqual([input[0]!.verdict, input[1]!.verdict]);
  });
});

describe("validateActivityBatch", () => {
  const data = { id: "d1", source: "ledger", kind: "debit", start: "2026-11-07T10:00:00Z" };

  it("validates examples with an injected now and reports accepted and rejected", () => {
    const result = validateActivityBatch(body([data, cov(), hb("ok")]), { registry, now });
    expect(result).toMatchObject({ ok: true, rejected: [] });
    expect(result.ok && result.accepted.map((e) => e.kind)).toEqual(["debit", "coverage", "heartbeat"]);
    // The same batch is out of bounds for a later clock.
    const later = validateActivityBatch(body([cov(), hb("ok")]), { registry, now: new Date("2028-01-01T00:00:00Z") });
    expect(later.ok && later.rejected.map((r) => r.index)).toEqual([0]);
  });

  it("refuses coverage when a row in another scope is rejected", () => {
    const result = validateActivityBatch(body([{ ...data, kind: "nope" }, cov({}, { scope: "a2" })]), {
      registry,
      now
    });
    expect(result.ok && result.rejected.map((r) => r.index)).toEqual([0, 1]);
    expect(result.ok && result.rejected[1]!.reason).toContain("coverage refused: event #0 of ledger");
  });

  it("refuses coverage when a rejected row has no readable source", () => {
    const result = validateActivityBatch(
      body([{ id: "x", source: "nowhere", kind: "k", start: "2026-11-07T10:00:00Z" }, cov()]),
      {
        registry,
        now
      }
    );
    expect(result.ok && result.rejected[1]!.reason).toContain("source could not be read");
  });

  it("uses the batch device in the heartbeat key and treats an import as not live", () => {
    const withDevice = validateActivityBatch(body([hb("ok", "2026-11-07T11:30:00Z", "box")], { device: "box" }), {
      registry,
      now
    });
    expect(withDevice).toMatchObject({ ok: true, rejected: [] });
    const old = cov({ start: "2025-01-01T00:00:00Z", end: "2025-01-31T00:00:00Z" });
    expect(validateActivityBatch(body([old]), { registry, now })).toMatchObject({ rejected: [{ index: 0 }] });
    const imported = validateActivityBatch(
      body([old], { import: { sha256: "a".repeat(64), filename: "s.csv", source: "ledger" } }),
      { registry, now }
    );
    expect(imported).toMatchObject({ ok: true, rejected: [] });
  });

  it("requires a scope on a message-family source's coverage row when asked to", () => {
    const scopeRequired = (s: string) => s === "chat";
    const row = (scope?: string) => cov({ source: "chat" }, scope ? { scope } : {});
    expect(validateActivityBatch(body([row()]), { registry, now, scopeRequired })).toMatchObject({
      rejected: [{ index: 0 }]
    });
    expect(validateActivityBatch(body([row("room-1")]), { registry, now, scopeRequired })).toMatchObject({
      rejected: []
    });
  });

  it("judges events the way the server does: the batch fields in, the post-pass left to the caller", () => {
    const inputs = judgeActivityEvents([hb("ok", "2026-11-07T11:30:00Z", "box"), { source: "nowhere" }], {
      registry,
      now,
      device: "box",
      live: true
    });
    expect(inputs.map((input) => [input.verdict.ok, input.source])).toEqual([
      [true, "stream"],
      [false, null]
    ]);
  });

  it("reports a bad envelope", () => {
    expect(validateActivityBatch({ schema: 2, events: [] }, { registry, now })).toMatchObject({ ok: false });
    expect(validateActivityBatch(null, { registry, now })).toMatchObject({ ok: false });
  });
});
