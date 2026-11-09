import { describe, expect, it } from "vitest";
import {
  AMBIGUOUS_TIME_GRACE_HOURS,
  EVENT_DEFAULT_DURATION_HOURS,
  ASK_HORIZON_DAYS,
  LINK_CHAIN_MAX,
  NO_TIME_HORIZON_DAYS,
  compareOpenFacts,
  foldFactStates,
  openFacts,
  statusActorOf,
  type FoldFactRow,
  type FoldLink,
  type FoldInput,
  type FoldOverride,
  type FoldStatus
} from "./fact-state.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString();
const id = (n: string) => n.padEnd(40, "0");

const fact = (name: string, over: Partial<FoldFactRow> = {}): FoldFactRow => ({
  key: `row-${name}-${over.tsStart ?? "t"}`,
  factId: id(name),
  factType: "ask",
  tsStart: ago(2),
  conversationKey: "gmail:t1",
  direction: "in",
  ...over
});
const status = (name: string, s: FoldStatus["status"], validFrom: string, actor: FoldStatus["actor"]): FoldStatus => ({
  factId: id(name),
  status: s,
  validFrom,
  actor,
  key: `st-${name}-${s}-${validFrom}-${actor}`
});
const override = (
  name: string,
  field: string,
  newValue: unknown,
  at: string,
  actor: FoldOverride["actor"]
): FoldOverride => ({ factId: id(name), field, newValue, at, actor, key: `ov-${name}-${field}-${at}-${actor}` });

const fold = (input: Partial<FoldInput> & { facts: FoldFactRow[] }) => {
  const result = foldFactStates({ now: NOW, ...input });
  return new Map(result.map((r) => [r.factId, r]));
};
const one = (input: Partial<FoldInput> & { facts: FoldFactRow[] }, name = "a") => fold(input).get(id(name))!;

describe("constants", () => {
  it("states the horizons", () => {
    expect(ASK_HORIZON_DAYS).toBe(14);
    expect(NO_TIME_HORIZON_DAYS).toBe(14);
    expect(AMBIGUOUS_TIME_GRACE_HOURS).toBe(24);
    expect(LINK_CHAIN_MAX).toBe(3);
  });
});

describe("statusActorOf", () => {
  it("reads the server-derived ingested_via: null is the person, an extractor is an extractor, any other agent is Mark", () => {
    expect(statusActorOf(null)).toBe("person");
    expect(statusActorOf("extractor:retention")).toBe("extractor");
    expect(statusActorOf("mark")).toBe("mark");
    expect(statusActorOf("openclaw-mark")).toBe("mark");
  });
});

describe("one row per fact wins", () => {
  it("uses the row from the latest source message, whatever the input order", () => {
    const rows = [
      fact("a", { key: "old", tsStart: ago(9) }),
      fact("a", { key: "new", tsStart: ago(1) }),
      fact("a", { key: "mid", tsStart: ago(4) })
    ];
    expect(one({ facts: rows }).rowKey).toBe("new");
    expect(one({ facts: [...rows].reverse() }).rowKey).toBe("new");
  });

  it("breaks a tie on message time by the higher ICS SEQUENCE, then by key", () => {
    const t = ago(3);
    const rows = [
      fact("a", { key: "s1", tsStart: t, sequence: 1 }),
      fact("a", { key: "s2", tsStart: t, sequence: 2 }),
      fact("a", { key: "none", tsStart: t })
    ];
    expect(one({ facts: rows }).rowKey).toBe("s2");
    const tie = [fact("a", { key: "a-key", tsStart: t }), fact("a", { key: "b-key", tsStart: t })];
    expect(one({ facts: tie }).rowKey).toBe("b-key");
    expect(one({ facts: [...tie].reverse() }).rowKey).toBe("b-key");
  });
});

describe("closure by reply", () => {
  it("closes an ask on a later from_self message in the same conversation", () => {
    const r = one({
      facts: [fact("a", { tsStart: ago(3) })],
      conversations: { "gmail:t1": [{ at: ago(2), fromSelf: true }] }
    });
    expect(r).toMatchObject({ state: "closed", open: false, closedBy: "reply", closedAt: ago(2), status: "done" });
  });

  it("is not closed by an earlier reply, by an incoming message, or by a reply in another conversation", () => {
    const base = fact("a", { tsStart: ago(3) });
    expect(one({ facts: [base], conversations: { "gmail:t1": [{ at: ago(4), fromSelf: true }] } }).open).toBe(true);
    expect(one({ facts: [base], conversations: { "gmail:t1": [{ at: ago(1), fromSelf: false }] } }).open).toBe(true);
    expect(one({ facts: [base], conversations: { "gmail:other": [{ at: ago(1), fromSelf: true }] } }).open).toBe(true);
  });

  it("does not close an outgoing ask or a commitment on his own next message", () => {
    const conversations = { "gmail:t1": [{ at: ago(1), fromSelf: true }] };
    expect(one({ facts: [fact("a", { direction: "out", tsStart: ago(3) })], conversations }).open).toBe(true);
    expect(
      one({ facts: [fact("a", { factType: "commitment", direction: "out", tsStart: ago(3) })], conversations }).open
    ).toBe(true);
  });

  it("does not close an event or a deadline by reply", () => {
    const when = { candidates: [{ start: ahead(3) }], ambiguous: false };
    const conversations = { "gmail:t1": [{ at: ago(1), fromSelf: true }] };
    expect(one({ facts: [fact("a", { factType: "event", when })], conversations }).open).toBe(true);
    expect(one({ facts: [fact("a", { factType: "deadline", when })], conversations }).open).toBe(true);
  });
});

describe("age-out", () => {
  it("expires an ask 14 days after the last message in the conversation, not after the ask", () => {
    const f = fact("a", { tsStart: ago(20) });
    expect(one({ facts: [f] })).toMatchObject({ state: "expired", open: false, status: "expired" });
    // A later incoming message in the thread keeps the ask alive for 14 days from that message.
    const alive = one({ facts: [f], conversations: { "gmail:t1": [{ at: ago(13), fromSelf: false }] } });
    expect(alive).toMatchObject({ state: "open", open: true });
    expect(alive.expiresAt).toBe(new Date(Date.parse(ago(13)) + 14 * DAY).toISOString());
    const stale = one({ facts: [f], conversations: { "gmail:t1": [{ at: ago(15), fromSelf: false }] } });
    expect(stale.state).toBe("expired");
  });

  it("expires exactly at the horizon", () => {
    expect(one({ facts: [fact("a", { tsStart: ago(13.99) })] }).open).toBe(true);
    expect(one({ facts: [fact("a", { tsStart: ago(14) })] }).state).toBe("expired");
  });

  it("ends an event or deadline at its resolved end (else start), and expires it then", () => {
    const type = "event";
    const future = { candidates: [{ start: ahead(2) }], ambiguous: false };
    const past = { candidates: [{ start: ago(1) }], ambiguous: false };
    expect(one({ facts: [fact("a", { factType: type, tsStart: ago(30), when: future })] }).open).toBe(true);
    expect(one({ facts: [fact("a", { factType: type, tsStart: ago(30), when: past })] }).state).toBe("expired");
    const running = { candidates: [{ start: ago(1), end: ahead(1) }], ambiguous: false };
    const r = one({ facts: [fact("a", { factType: "deadline", when: running })] });
    expect(r.open).toBe(true);
    expect(r.endsAt).toBe(ahead(1));
    expect(r.dueAt).toBe(ago(1));
  });

  it("expires an event with no resolved time 14 days after its source message", () => {
    const none = { candidates: [], ambiguous: true };
    expect(one({ facts: [fact("a", { factType: "event", tsStart: ago(13), when: none })] }).open).toBe(true);
    expect(one({ facts: [fact("a", { factType: "event", tsStart: ago(15), when: none })] }).state).toBe("expired");
    expect(one({ facts: [fact("a", { factType: "deadline", tsStart: ago(15) })] }).state).toBe("expired");
  });

  it("keeps an ambiguous (all-day, recurring) time for a day of grace after its latest reading", () => {
    const when = { candidates: [{ start: ago(0.5) }, { start: ago(0.2) }], ambiguous: true };
    const r = one({ facts: [fact("a", { factType: "event", tsStart: ago(5), when })] });
    expect(r.open).toBe(true);
    expect(r.endsAt).toBe(new Date(Date.parse(ago(0.2)) + 27 * 3_600_000).toISOString());
    const gone = { candidates: [{ start: ago(2) }], ambiguous: true };
    expect(one({ facts: [fact("a", { factType: "event", tsStart: ago(5), when: gone })] }).state).toBe("expired");
  });
});

describe("statuses", () => {
  it("closes on a done, cancelled or superseded status", () => {
    for (const s of ["done", "cancelled", "superseded"] as const) {
      const r = one({
        facts: [fact("a", { tsStart: ago(3) })],
        statuses: [status("a", s, ago(2), "person")]
      });
      expect(r).toMatchObject({ state: "closed", closedBy: "status", status: s, actor: "person" });
    }
  });

  it("treats source_gone as closed but never as a reopening statement", () => {
    const r = one({ facts: [fact("a")], statuses: [status("a", "source_gone", ago(1), "extractor")] });
    expect(r).toMatchObject({ state: "closed", status: "source_gone" });
  });

  it("lets the person's word beat Mark's at the same instant and the latest word win otherwise", () => {
    const f = fact("a", { tsStart: ago(5) });
    const t = ago(4);
    const tie = one({ facts: [f], statuses: [status("a", "done", t, "mark"), status("a", "confirmed", t, "person")] });
    expect(tie).toMatchObject({ state: "open", status: "confirmed", actor: "person" });
    const later = one({
      facts: [f],
      statuses: [status("a", "confirmed", ago(4), "person"), status("a", "cancelled", ago(3), "mark")]
    });
    expect(later).toMatchObject({ state: "closed", status: "cancelled", actor: "mark" });
  });

  it("an extractor status never outranks a person's at the same instant", () => {
    const t = ago(1);
    const r = one({
      facts: [fact("a", { tsStart: ago(3) })],
      statuses: [status("a", "source_gone", t, "extractor"), status("a", "confirmed", t, "person")]
    });
    expect(r.status).toBe("confirmed");
  });

  it("ignores statuses about other facts", () => {
    const r = one({ facts: [fact("a")], statuses: [status("b", "done", ago(1), "person")] });
    expect(r.open).toBe(true);
  });

  it("still ages an owner-confirmed ask out", () => {
    const r = one({
      facts: [fact("a", { tsStart: ago(30) })],
      statuses: [status("a", "confirmed", ago(29), "person")]
    });
    expect(r.state).toBe("expired");
  });
});

describe("reopen", () => {
  it("a later message carrying the fact reopens it after done, cancelled or superseded", () => {
    const r = one({
      facts: [fact("a", { key: "first", tsStart: ago(6) }), fact("a", { key: "again", tsStart: ago(1) })],
      statuses: [status("a", "done", ago(3), "person")]
    });
    expect(r).toMatchObject({ state: "reopened", open: true, reopened: true, rowKey: "again" });
  });

  it("does not reopen when the closing status is later than the latest message", () => {
    const r = one({
      facts: [fact("a", { key: "first", tsStart: ago(6) }), fact("a", { key: "again", tsStart: ago(4) })],
      statuses: [status("a", "done", ago(3), "person")]
    });
    expect(r).toMatchObject({ state: "closed", reopened: false });
  });

  it("any later message in the conversation is not enough: only a message carrying the fact reopens", () => {
    const r = one({
      facts: [fact("a", { tsStart: ago(6) })],
      statuses: [status("a", "done", ago(3), "person")],
      conversations: { "gmail:t1": [{ at: ago(1), fromSelf: false }] }
    });
    expect(r.state).toBe("closed");
  });

  it("a reply after the reopening message closes it again", () => {
    const r = one({
      facts: [fact("a", { key: "first", tsStart: ago(6) }), fact("a", { key: "again", tsStart: ago(2) })],
      statuses: [status("a", "done", ago(4), "person")],
      conversations: { "gmail:t1": [{ at: ago(1), fromSelf: true }] }
    });
    expect(r).toMatchObject({ state: "closed", closedBy: "reply" });
  });

  it("a closing status after the reopening message closes it", () => {
    const r = one({
      facts: [fact("a", { key: "first", tsStart: ago(6) }), fact("a", { key: "again", tsStart: ago(2) })],
      statuses: [status("a", "done", ago(4), "person"), status("a", "done", ago(1), "person")]
    });
    expect(r.state).toBe("closed");
  });
});

describe("links, resolved at read", () => {
  const event = (name: string, tsStart: string, extra: Partial<FoldFactRow> = {}): FoldFactRow =>
    fact(name, {
      factType: "event",
      tsStart,
      when: { candidates: [{ start: ahead(5) }], ambiguous: false },
      ...extra
    });
  const cancel = (name: string, target: string, tsStart: string, extra: Partial<FoldFactRow> = {}): FoldFactRow =>
    fact(name, {
      factType: "event",
      tsStart,
      links: [{ relation: "cancel", targetFactId: id(target) }],
      when: { candidates: [], ambiguous: true },
      ...extra
    });

  it("a cancel closes its target, and the link row itself is never an open fact", () => {
    const input = { facts: [event("a", ago(6)), cancel("c", "a", ago(2))] };
    const result = fold(input);
    expect(result.get(id("a"))).toMatchObject({ state: "closed", closedBy: "link", status: "cancelled" });
    expect(result.get(id("c"))).toMatchObject({ state: "link", open: false, isLink: true });
    expect(openFacts([...result.values()])).toEqual([]);
  });

  it("works whatever order the rows arrive in (backfill is newest first)", () => {
    const rows = [event("a", ago(6)), cancel("c", "a", ago(2))];
    expect(one({ facts: rows }).state).toBe("closed");
    expect(one({ facts: [...rows].reverse() }).state).toBe("closed");
  });

  it("ignores a link whose target is not earlier than the link row (a repeat after the cancel is a new event)", () => {
    expect(one({ facts: [event("a", ago(1)), cancel("c", "a", ago(2))] }).open).toBe(true);
    expect(one({ facts: [event("a", ago(2)), cancel("c", "a", ago(2))] }).open).toBe(true);
  });

  it("an orphan link row (its named target is absent) is a plain fact and is listed, so it never hides a real event", () => {
    const result = fold({ facts: [cancel("c", "zz", ago(2), { when: undefined })] });
    expect(result.get(id("c"))).toMatchObject({ state: "open", isLink: false });
    expect(openFacts([...result.values()]).map((r) => r.factId)).toEqual([id("c")]);
    const move: FoldFactRow = fact("m", {
      factType: "event",
      links: [{ relation: "reschedule", targetFactId: id("zz") }],
      when: { candidates: [{ start: ahead(3) }], ambiguous: false }
    });
    expect(one({ facts: [move] }, "m")).toMatchObject({ open: true, dueAt: ahead(3) });
  });

  it("a person's or Mark's status beats the link, which shows as a note", () => {
    for (const actor of ["person", "mark"] as const) {
      const r = one({
        facts: [event("a", ago(6)), cancel("c", "a", ago(2))],
        statuses: [status("a", "confirmed", ago(1), actor)]
      });
      expect(r).toMatchObject({ state: "open", updateSeen: true, closedBy: null });
    }
    const done = one({
      facts: [event("a", ago(6)), cancel("c", "a", ago(2))],
      statuses: [status("a", "done", ago(1), "person")]
    });
    expect(done).toMatchObject({ state: "closed", closedBy: "status", updateSeen: true });
  });

  it("a status older than the link does not neutralise a later cancel", () => {
    for (const actor of ["person", "mark"] as const) {
      const r = one({
        facts: [event("a", ago(6)), cancel("c", "a", ago(2))],
        statuses: [status("a", "confirmed", ago(5), actor)]
      });
      expect(r).toMatchObject({ state: "closed", closedBy: "link" });
    }
  });

  it("an extractor status does not beat a link", () => {
    const r = one({
      facts: [event("a", ago(6)), cancel("c", "a", ago(2))],
      statuses: [status("a", "confirmed", ago(5), "extractor")]
    });
    expect(r.closedBy).toBe("link");
  });

  it("a link the person closed is void and cancels nothing", () => {
    const r = one({
      facts: [event("a", ago(6)), cancel("c", "a", ago(2))],
      statuses: [status("c", "superseded", ago(1), "person")]
    });
    expect(r.open).toBe(true);
  });

  const noTarget = (relation: FoldLink["relation"] = "cancel") => [{ relation, targetFactId: null }];

  it("falls back to ics_uid, then to a single event in the conversation, only when the link names no target", () => {
    const byUid = [
      event("a", ago(6), { icsUid: "uid-1" }),
      cancel("c", "a", ago(2), { icsUid: "uid-1", links: noTarget() })
    ];
    expect(one({ facts: byUid }).closedBy).toBe("link");
    const byConversation = [event("a", ago(6)), cancel("c", "a", ago(2), { links: noTarget() })];
    expect(one({ facts: byConversation }).closedBy).toBe("link");
    // Two candidate events in the conversation: ambiguous, so nothing is cancelled.
    const two = fold({
      facts: [event("a", ago(6)), event("b", ago(5)), cancel("c", "a", ago(2), { links: noTarget() })]
    });
    expect(two.get(id("a"))?.open).toBe(true);
    expect(two.get(id("b"))?.open).toBe(true);
  });

  it("a named target that is not in the read set is orphaned: no fallback to the uid or the conversation", () => {
    const rows = [event("a", ago(6), { icsUid: "uid-1" }), cancel("c", "zz", ago(2), { icsUid: "uid-1" })];
    expect(one({ facts: rows }).open).toBe(true);
  });

  it("the ics_uid fallback never crosses conversations, and neither does the conversation fallback", () => {
    const rows = [
      event("a", ago(6), { icsUid: "uid-1", conversationKey: "gmail:x" }),
      cancel("c", "a", ago(2), { icsUid: "uid-1", links: noTarget() })
    ];
    expect(one({ facts: rows }).open).toBe(true);
    const other = [event("a", ago(6), { conversationKey: "gmail:x" }), cancel("c", "a", ago(2), { links: noTarget() })];
    expect(one({ facts: other }).open).toBe(true);
  });

  it("a reschedule keeps the target open at the new time and moves its expiry", () => {
    const move: FoldFactRow = fact("m", {
      factType: "event",
      tsStart: ago(2),
      links: [{ relation: "reschedule", targetFactId: id("a") }],
      when: { candidates: [{ start: ahead(9) }], ambiguous: false }
    });
    const target = event("a", ago(6), { when: { candidates: [{ start: ago(1) }], ambiguous: false } });
    const r = one({ facts: [target, move] });
    expect(r).toMatchObject({
      state: "open",
      status: "rescheduled",
      dueAt: ahead(9),
      endsAt: new Date(Date.parse(ahead(9)) + 3 * 3_600_000).toISOString()
    });
    expect(r.movedBy).toBe(id("m"));
  });

  it("a repeat is a new ask: it restarts the reply and age-out clocks", () => {
    const again: FoldFactRow = fact("r", {
      tsStart: ago(1),
      links: [{ relation: "repeat", targetFactId: id("a") }]
    });
    const ask = fact("a", { tsStart: ago(20) });
    expect(one({ facts: [ask] }).state).toBe("expired");
    const r = one({ facts: [ask, again] });
    expect(r).toMatchObject({ state: "open", repeatedAt: ago(1) });
    const replied = one({
      facts: [ask, again],
      conversations: { "gmail:t1": [{ at: ago(10), fromSelf: true }] }
    });
    expect(replied.open).toBe(true);
  });

  it("follows a chain of at most three links to the root", () => {
    const root = event("a", ago(14));
    const move = (name: string, target: string, tsStart: string): FoldFactRow =>
      fact(name, {
        factType: "event",
        tsStart,
        links: [{ relation: "reschedule", targetFactId: id(target) }],
        when: { candidates: [{ start: ahead(9) }], ambiguous: false }
      });
    const cancelOf = (name: string, target: string, tsStart: string): FoldFactRow =>
      fact(name, { factType: "event", tsStart, links: [{ relation: "cancel", targetFactId: id(target) }] });
    // d -> c -> b -> a is three hops: the cancel reaches the root.
    const three = [root, move("b", "a", ago(10)), move("c", "b", ago(8)), cancelOf("d", "c", ago(6))];
    expect(one({ facts: three }).closedBy).toBe("link");
    // e -> d -> c -> b -> a is four hops: the cancel is ignored and the latest link inside the limit (d) decides.
    const four = [
      root,
      move("b", "a", ago(10)),
      move("c", "b", ago(8)),
      move("d", "c", ago(6)),
      cancelOf("e", "d", ago(4))
    ];
    expect(one({ facts: four })).toMatchObject({ state: "open", status: "rescheduled", movedBy: id("d") });
    expect(one({ facts: [...four].reverse() }).movedBy).toBe(id("d"));
  });

  it("cannot loop: a link to a later or equal row is ignored", () => {
    const a: FoldFactRow = fact("a", { tsStart: ago(5), links: [{ relation: "reschedule", targetFactId: id("b") }] });
    const b: FoldFactRow = fact("b", { tsStart: ago(3), links: [{ relation: "reschedule", targetFactId: id("a") }] });
    const result = fold({ facts: [a, b] });
    // Neither link resolves, so neither hides anything: both are plain facts.
    expect([...result.values()].every((r) => r.state === "open" && !r.isLink)).toBe(true);
  });

  it("the latest of several links decides", () => {
    const move: FoldFactRow = fact("m", {
      factType: "event",
      tsStart: ago(4),
      links: [{ relation: "reschedule", targetFactId: id("a") }],
      when: { candidates: [{ start: ahead(9) }], ambiguous: false }
    });
    const r = one({ facts: [event("a", ago(6)), move, cancel("c", "a", ago(2))] });
    expect(r.closedBy).toBe("link");
    const r2 = one({ facts: [event("a", ago(6)), cancel("c", "a", ago(4)), { ...move, tsStart: ago(2) }] });
    expect(r2).toMatchObject({ state: "open", status: "rescheduled" });
  });
});

describe("overrides", () => {
  it("applies the person's correction of the type and the time", () => {
    const f = fact("a", { tsStart: ago(30) });
    expect(one({ facts: [f] }).state).toBe("expired");
    const r = one({
      facts: [f],
      overrides: [
        override("a", "fact_type", "deadline", ago(1), "person"),
        override("a", "when", { start: ahead(2) }, ago(1), "person")
      ]
    });
    expect(r).toMatchObject({ state: "open", factType: "deadline", dueAt: ahead(2) });
  });

  it("the person's override beats an agent's whatever the time, and a later agent override beats an earlier agent's", () => {
    const f = fact("a", { factType: "event", tsStart: ago(30) });
    const r = one({
      facts: [f],
      overrides: [
        override("a", "when", { start: ahead(2) }, ago(5), "person"),
        override("a", "when", { start: ahead(8) }, ago(1), "mark")
      ]
    });
    expect(r.dueAt).toBe(ahead(2));
    const agents = one({
      facts: [f],
      overrides: [
        override("a", "when", { start: ahead(2) }, ago(5), "mark"),
        override("a", "when", { start: ahead(8) }, ago(1), "mark")
      ]
    });
    expect(agents.dueAt).toBe(ahead(8));
  });

  it("null clears the time; a bare RFC 3339 string sets it; garbage is ignored", () => {
    const f = fact("a", {
      factType: "event",
      tsStart: ago(5),
      when: { candidates: [{ start: ago(1) }], ambiguous: false }
    });
    expect(one({ facts: [f] }).state).toBe("expired");
    const cleared = one({ facts: [f], overrides: [override("a", "when", null, ago(1), "person")] });
    expect(cleared).toMatchObject({ state: "open", dueAt: null });
    const set = one({ facts: [f], overrides: [override("a", "when", ahead(3), ago(1), "person")] });
    expect(set.dueAt).toBe(ahead(3));
    const bad = one({ facts: [f], overrides: [override("a", "when", { nonsense: true }, ago(1), "person")] });
    expect(bad.state).toBe("expired");
    const badType = one({ facts: [f], overrides: [override("a", "fact_type", "bogus", ago(1), "person")] });
    expect(badType.factType).toBe("event");
  });
});

describe("ordering", () => {
  it("lists timed events and deadlines soonest first, then asks and the rest newest first", () => {
    const facts = [
      fact("a", { tsStart: ago(5) }),
      fact("b", { tsStart: ago(1) }),
      fact("c", {
        factType: "event",
        tsStart: ago(9),
        when: { candidates: [{ start: ahead(6) }], ambiguous: false }
      }),
      fact("d", {
        factType: "deadline",
        tsStart: ago(8),
        when: { candidates: [{ start: ahead(1) }], ambiguous: false }
      }),
      fact("e", { factType: "commitment", direction: "out", tsStart: ago(3) })
    ];
    const listed = openFacts([...fold({ facts }).values()]).map((r) => r.factId);
    expect(listed).toEqual([id("d"), id("c"), id("b"), id("e"), id("a")]);
    const reversed = openFacts(foldFactStates({ now: NOW, facts: [...facts].reverse() })).map((r) => r.factId);
    expect(reversed).toEqual(listed);
  });

  it("compareOpenFacts is a total order (ties fall to the fact id)", () => {
    const [x, y] = [...fold({ facts: [fact("a", { tsStart: ago(1) }), fact("b", { tsStart: ago(1) })] }).values()];
    expect(Math.sign(compareOpenFacts(x!, y!))).toBe(-Math.sign(compareOpenFacts(y!, x!)));
    expect(compareOpenFacts(x!, y!)).not.toBe(0);
  });

  it("openFacts leaves out closed, expired and link rows", () => {
    const facts = [
      fact("a", { tsStart: ago(30) }),
      fact("b", { tsStart: ago(3) }),
      fact("c", { tsStart: ago(2) }),
      fact("d", { tsStart: ago(1), links: [{ relation: "repeat", targetFactId: id("c") }] })
    ];
    const listed = openFacts(foldFactStates({ now: NOW, facts, statuses: [status("b", "done", ago(1), "person")] }));
    expect(listed.map((r) => r.factId)).toEqual([id("c")]);
  });
});

describe("hardening", () => {
  const ev = (over: Partial<FoldFactRow> = {}) => fact("a", { factType: "event", tsStart: ago(1), ...over });

  it("clamps a status's time to when it was recorded, so a far-future valid_from cannot pin an open status", () => {
    const pinned: FoldStatus = {
      ...status("a", "proposed", "2199-01-01T00:00:00Z", "mark"),
      ingestedAt: ago(5)
    };
    const done: FoldStatus = { ...status("a", "done", ago(2), "person"), ingestedAt: ago(2) };
    const r = one({ facts: [fact("a", { tsStart: ago(6) })], statuses: [pinned, done] });
    expect(r).toMatchObject({ state: "closed", status: "done" });
    // Without a recorded time the stated one stands (the pure fold's old behaviour).
    expect(
      one({ facts: [fact("a", { tsStart: ago(6) })], statuses: [{ ...pinned, ingestedAt: undefined }, done] }).state
    ).toBe("open");
  });

  it("never throws on extreme or unreadable times and ignores them", () => {
    const extreme = [
      "9999-01-01T00:00:00Z",
      "+275760-09-13T00:00:00.000Z",
      "-000001-01-01T00:00:00Z",
      "garbage",
      "1969-12-31T23:59:59Z"
    ];
    for (const value of extreme) {
      expect(() =>
        foldFactStates({
          now: NOW,
          facts: [ev({ when: { candidates: [{ start: value, end: value }], ambiguous: true } })],
          overrides: [
            override("a", "when", { start: value }, ago(1), "person"),
            override("a", "when", value, ago(1), "mark")
          ],
          statuses: [status("a", "confirmed", value, "person")]
        })
      ).not.toThrow();
    }
    const r = one({
      facts: [ev()],
      overrides: [override("a", "when", { start: "9999-01-01T00:00:00Z" }, ago(0.5), "person")]
    });
    expect(r.dueAt).toBeNull();
    expect(() => foldFactStates({ now: NOW, facts: [fact("a", { tsStart: "nonsense" }), fact("b")] })).not.toThrow();
    expect(fold({ facts: [fact("a", { tsStart: "nonsense" })] }).size).toBe(0);
  });

  it("reads a time with no offset as unreadable, whatever the server's zone", () => {
    const before = process.env.TZ;
    try {
      for (const zone of ["America/New_York", "Pacific/Auckland", "UTC"]) {
        process.env.TZ = zone;
        const set = one({
          facts: [ev({ tsStart: ago(5), when: { candidates: [{ start: ago(3) }], ambiguous: false } })],
          overrides: [
            override("a", "when", "2099-11-13T09:00:00", ago(1), "person"),
            override("a", "when", { start: "2099-11-13T09:00:00" }, ago(1), "mark")
          ]
        });
        // Both overrides are unreadable and ignored, so the row's own (past) time stands.
        expect(set.state).toBe("expired");
        const withOffset = one({
          facts: [ev({ tsStart: ago(5) })],
          overrides: [override("a", "when", "2099-11-13T09:00:00+11:00", ago(1), "person")]
        });
        expect(withOffset.dueAt).toBe("2099-11-12T22:00:00.000Z");
        const rowCandidate = one({
          facts: [ev({ tsStart: ago(5), when: { candidates: [{ start: "2099-11-13T09:00:00" }], ambiguous: false } })]
        });
        expect(rowCandidate.dueAt).toBeNull();
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("gives an event with a start and no end three hours, so a meeting that began minutes ago is open", () => {
    const start = new Date(NOW.getTime() - 14 * 60_000).toISOString();
    const r = one({ facts: [ev({ when: { candidates: [{ start }], ambiguous: false } })] });
    expect(r.open).toBe(true);
    expect(r.endsAt).toBe(new Date(Date.parse(start) + EVENT_DEFAULT_DURATION_HOURS * 3_600_000).toISOString());
    const late = new Date(NOW.getTime() - 4 * 3_600_000).toISOString();
    expect(one({ facts: [ev({ when: { candidates: [{ start: late }], ambiguous: false } })] }).state).toBe("expired");
    // A deadline is a moment: it ends when it arrives.
    const deadline = one({
      facts: [ev({ factType: "deadline", when: { candidates: [{ start }], ambiguous: false } })]
    });
    expect(deadline.state).toBe("expired");
  });

  it("dates a fact by the earlier of its message time and when it was recorded, so a future-dated message cannot reopen a closure", () => {
    const sentFuture = new Date(NOW.getTime() + 23 * 3_600_000).toISOString();
    const rows = [
      fact("a", { key: "first", tsStart: ago(6) }),
      fact("a", { key: "future", tsStart: sentFuture, ingestedAt: ago(0.01) })
    ];
    const r = one({ facts: rows, statuses: [status("a", "done", NOW.toISOString(), "person")] });
    expect(r).toMatchObject({ state: "closed", reopened: false });
    // The same message honestly dated after the closure does reopen it.
    const honest = [fact("a", { key: "first", tsStart: ago(6) }), fact("a", { key: "later", tsStart: ago(0.5) })];
    expect(one({ facts: honest, statuses: [status("a", "done", ago(1), "person")] }).state).toBe("reopened");
  });

  it("does not move a fact more than a year past the reschedule's own message", () => {
    const move = (days: number): FoldFactRow =>
      fact("m", {
        factType: "event",
        tsStart: ago(2),
        links: [{ relation: "reschedule", targetFactId: id("a") }],
        when: { candidates: [{ start: ahead(days) }], ambiguous: false }
      });
    const target = ev({ tsStart: ago(6), when: { candidates: [{ start: ahead(5) }], ambiguous: false } });
    const far = one({ facts: [target, move(400)] });
    expect(far).toMatchObject({ state: "open", updateSeen: true, movedBy: null, dueAt: ahead(5) });
    expect(far.status).not.toBe("rescheduled");
    expect(one({ facts: [target, move(300)] })).toMatchObject({ status: "rescheduled", dueAt: ahead(300) });
  });

  it("lets repeats extend a fact's life to 90 days from its message and no further", () => {
    const again = fact("r", { tsStart: ago(1), links: [{ relation: "repeat", targetFactId: id("a") }] });
    const old = fact("a", { tsStart: ago(120) });
    expect(one({ facts: [old, again] }).state).toBe("expired");
    const young = fact("a", { tsStart: ago(80) });
    const r = one({ facts: [young, again] });
    expect(r.open).toBe(true);
    expect(r.expiresAt).toBe(new Date(Date.parse(ago(1)) + 14 * DAY).toISOString());
  });
});
