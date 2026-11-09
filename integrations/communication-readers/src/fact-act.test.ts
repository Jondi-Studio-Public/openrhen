import { describe, expect, it } from "vitest";
import {
  FACT_CLOSINGS_PER_DAY,
  FACT_CLOSINGS_PER_HOUR,
  FACT_HOLD_DEFAULT_DAYS,
  FACT_HOLD_MAX_DAYS,
  FACT_WRITES_PER_HOUR,
  agentMarks,
  planFactAct,
  type FactActInput
} from "./fact-act.js";
import { foldFactStates, type FoldFactRow, type FoldInput, type FoldOverride, type FoldStatus } from "./fact-state.js";

const NOW = new Date("2026-11-08T12:00:00Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();
const ago = (days: number) => at(-days * DAY);
const ahead = (days: number) => at(days * DAY);
const id = (n: string) => n.padEnd(40, "0");
const MARK = "mark";
const minute = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}Z`;

const ask = (over: Partial<FoldFactRow> = {}): FoldFactRow => ({
  key: "row-a",
  factId: id("a"),
  factType: "ask",
  tsStart: ago(2),
  ingestedAt: ago(2),
  conversationKey: "gmail:t1",
  direction: "in",
  ...over
});
const event = (over: Partial<FoldFactRow> = {}): FoldFactRow =>
  ask({
    key: "row-e",
    factId: id("e"),
    factType: "event",
    conversationKey: null,
    when: { candidates: [{ start: ahead(5) }], ambiguous: false },
    ...over
  });
const status = (
  name: string,
  s: FoldStatus["status"],
  validFrom: string,
  actor: FoldStatus["actor"],
  over: Partial<FoldStatus> = {}
): FoldStatus => ({
  factId: id(name),
  status: s,
  validFrom,
  actor,
  key: `st-${name}-${s}-${validFrom}-${actor}`,
  ingestedAt: validFrom,
  by: actor === "mark" ? MARK : actor === "person" ? null : "extractor:x",
  ...over
});
const override = (
  name: string,
  field: string,
  newValue: unknown,
  when: string,
  actor: FoldOverride["actor"],
  over: Partial<FoldOverride> = {}
): FoldOverride => ({
  factId: id(name),
  field,
  newValue,
  at: when,
  actor,
  key: `ov-${name}-${field}-${when}-${actor}`,
  by: actor === "mark" ? MARK : null,
  ...over
});

const STATED = { basis: "stated", evidence: "Jondi said it is handled" } as const;
function run(
  action: string,
  name: string,
  fold: Partial<FoldInput> & { facts: readonly FoldFactRow[] },
  rest: Partial<FactActInput> = {}
) {
  return planFactAct({
    action,
    factId: id(name),
    by: MARK,
    now: NOW,
    set: {},
    fold: { now: NOW, ...fold },
    ...rest
  });
}
const refusal = (plan: ReturnType<typeof planFactAct>) => {
  if (plan.ok) throw new Error(`expected a refusal, got ${JSON.stringify(plan.rows)}`);
  return plan;
};
const accepted = (plan: ReturnType<typeof planFactAct>) => {
  if (!plan.ok) throw new Error(`expected success, got ${plan.code}: ${plan.message}`);
  return plan;
};
const folded = (input: FoldInput, name: string) => foldFactStates(input).find((f) => f.factId === id(name))!;

describe("constants", () => {
  it("states the limits", () => {
    expect([FACT_HOLD_DEFAULT_DAYS, FACT_HOLD_MAX_DAYS]).toEqual([14, 30]);
    expect([FACT_CLOSINGS_PER_HOUR, FACT_CLOSINGS_PER_DAY, FACT_WRITES_PER_HOUR]).toEqual([5, 15, 10]);
  });
});

describe("request shape", () => {
  it("refuses an unknown action and names the five", () => {
    const r = refusal(run("hold", "a", { facts: [ask()] }));
    expect(r.code).toBe("unknown_action");
    for (const name of ["confirm", "done", "ignore", "redate", "reopen"]) expect(r.message).toContain(name);
  });

  it("refuses an id that is not 40 hex characters before reading anything, echoing at most 40 characters", () => {
    const r = refusal(
      planFactAct({
        action: "done",
        factId: "x".repeat(200),
        by: MARK,
        now: NOW,
        set: {},
        fold: { now: NOW, facts: [] }
      })
    );
    expect(r.code).toBe("bad_id");
    expect(r.message).not.toContain("x".repeat(41));
    expect(r.message).toContain("40 hex");
  });

  it("refuses an unknown fact with the call that lists the ids", () => {
    const r = refusal(run("done", "ff", { facts: [ask()] }, STATED));
    expect(r.code).toBe("not_found");
    expect(r.message).toContain('rhen_inbox {"room":"facts"}');
    expect(r.message).toContain("Nothing was changed");
  });

  it("refuses a key the action does not take, naming the keys it does", () => {
    const r = refusal(run("confirm", "a", { facts: [ask()] }, { set: { when: "2026-12-01T10:00:00+00:00" } }));
    expect(r.code).toBe("bad_params");
    expect(r.message).toContain("days");
    const s = refusal(run("redate", "e", { facts: [event()] }, { ...STATED, set: { days: "3" } }));
    expect(s.message).toMatch(/when/);
    expect(refusal(run("done", "a", { facts: [ask()] }, { ...STATED, set: { days: "3" } })).code).toBe("bad_params");
  });

  it("refuses a caller with no agent name", () => {
    expect(refusal(run("done", "a", { facts: [ask()] }, { ...STATED, by: "" })).code).toBe("no_agent");
  });
});

describe("confirm (hold an ask or commitment open)", () => {
  it("holds for 14 days by default: a confirmed status with expires_at = now + 14 days, stamped with the act", () => {
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    const plan = accepted(run("confirm", "a", { facts: [stale] }));
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      kind: "fact_status",
      attrs: {
        fact_id: id("a"),
        status: "confirmed",
        act: "confirm",
        expires_at: ahead(14),
        valid_from: NOW.toISOString()
      }
    });
  });

  it("never shortens: the hold is the later of N days and the current expiry, and a hold that adds nothing is refused", () => {
    const fresh = ask({ tsStart: ago(1), ingestedAt: ago(1) }); // expires in 13 days
    const longer = accepted(run("confirm", "a", { facts: [fresh] }, { set: { days: "20" } }));
    expect(longer.rows[0]!.attrs.expires_at).toBe(ahead(20));
    const shorter = refusal(run("confirm", "a", { facts: [fresh] }, { set: { days: "1" } }));
    expect(shorter.code).toBe("no_effect");
    expect(shorter.message).toContain("already open until");
    expect(shorter.message).toContain("Nothing was changed");
  });

  it("allows 1 to 30 days and refuses anything else with the example", () => {
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    for (const days of ["0", "31", "-1", "1.5", "abc", "", "90"]) {
      const r = refusal(run("confirm", "a", { facts: [stale] }, { set: { days } }));
      expect(r.code, days).toBe("bad_params");
      expect(r.message, days).toContain("1 to 30");
      expect(r.message, days).toContain('set ["days=14"]');
    }
    expect(accepted(run("confirm", "a", { facts: [stale] }, { set: { days: "30" } })).rows[0]!.attrs.expires_at).toBe(
      ahead(30)
    );
    expect(
      accepted(run("confirm", "a", { facts: [stale] }, { set: { days: 7 as never } })).rows[0]!.attrs.expires_at
    ).toBe(ahead(14 - 14 + 7));
  });

  it("truncates an echoed bad value to 40 characters", () => {
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    const r = refusal(run("confirm", "a", { facts: [stale] }, { set: { days: "9".repeat(300) } }));
    expect(r.message).not.toContain("9".repeat(41));
  });

  it("is refused for an event or a deadline: confirm days=1 can no longer hide a deadline 60 days away (B2)", () => {
    const deadline = event({ factType: "deadline", when: { candidates: [{ start: ahead(60) }], ambiguous: false } });
    for (const row of [deadline, event()]) {
      const r = refusal(run("confirm", "e", { facts: [row] }, { set: { days: "1" } }));
      expect(r.code).toBe("wrong_type");
      expect(r.message).toContain("redate");
    }
  });

  it("accepts a commitment", () => {
    const c = ask({ factType: "commitment", tsStart: ago(13), ingestedAt: ago(13) });
    expect(accepted(run("confirm", "a", { facts: [c] })).rows[0]!.attrs.status).toBe("confirmed");
  });

  it("needs no basis, and the fold after the hold keeps the ask open until the new date", () => {
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    const input: FoldInput = { now: NOW, facts: [stale] };
    const plan = accepted(run("confirm", "a", input));
    const row = plan.rows[0]!.attrs;
    const after = folded(
      {
        ...input,
        statuses: [status("a", "confirmed", row.valid_from as string, "mark", { expiresAt: row.expires_at as string })]
      },
      "a"
    );
    expect(after).toMatchObject({ open: true, expiresAt: ahead(14) });
  });
});

describe("done and ignore (hiding actions)", () => {
  it("need basis stated and the owner's words, and say what to send", () => {
    for (const action of ["done", "ignore"]) {
      const none = refusal(run(action, "a", { facts: [ask()] }));
      expect(none.code).toBe("needs_stated");
      expect(none.message).toContain('basis "stated"');
      expect(none.message).toContain("evidence");
      expect(refusal(run(action, "a", { facts: [ask()] }, { basis: "inferred", evidence: "x" })).code).toBe(
        "needs_stated"
      );
      expect(refusal(run(action, "a", { facts: [ask()] }, { basis: "stated" })).code).toBe("needs_stated");
      expect(refusal(run(action, "a", { facts: [ask()] }, { basis: "stated", evidence: "   " })).code).toBe(
        "needs_stated"
      );
    }
  });

  it("write done and cancelled with the basis and truncated evidence stored on the row", () => {
    const done = accepted(run("done", "a", { facts: [ask()] }, STATED));
    expect(done.rows).toHaveLength(1);
    expect(done.rows[0]).toMatchObject({
      kind: "fact_status",
      attrs: { status: "done", act: "done", basis: "stated", evidence: STATED.evidence, valid_from: NOW.toISOString() }
    });
    const ignore = accepted(run("ignore", "a", { facts: [ask()] }, { basis: "stated", evidence: "e".repeat(500) }));
    expect(ignore.rows[0]!.attrs.status).toBe("cancelled");
    expect(String(ignore.rows[0]!.attrs.evidence)).toHaveLength(300);
  });

  it("say the truth about reopening: only the same ask coming up again, and the plan action is not changed", () => {
    const text = accepted(run("done", "a", { facts: [ask()] }, STATED)).message;
    expect(text).toContain("same ask");
    expect(text).toContain("different new mail does not reopen");
    expect(text).toContain("plan");
    expect(text).toContain('"action":"reopen"');
    expect(text).not.toContain("later mail in the conversation reopens");
  });

  it("close the fact in the fold", () => {
    const input: FoldInput = { now: NOW, facts: [ask()] };
    const row = accepted(run("ignore", "a", input, STATED)).rows[0]!.attrs;
    const after = folded({ ...input, statuses: [status("a", "cancelled", row.valid_from as string, "mark")] }, "a");
    expect(after.state).toBe("closed");
  });

  it("works on an event, which is open until it ends", () => {
    expect(accepted(run("done", "e", { facts: [event()] }, STATED)).rows[0]!.attrs.status).toBe("done");
  });
});

describe("redate (an event or a deadline whose time is wrong)", () => {
  const when = ahead(10);

  it("writes a Mark override of `when` shaped {start, end?}, in UTC", () => {
    const plan = accepted(
      run("redate", "e", { facts: [event()] }, { ...STATED, set: { when: "2026-11-20T15:00:00+01:00" } })
    );
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      kind: "override",
      attrs: {
        fact_id: id("e"),
        field: "when",
        new_value: { start: "2026-11-20T14:00:00.000Z" },
        act: "redate",
        basis: "stated"
      }
    });
    const ranged = accepted(
      run(
        "redate",
        "e",
        { facts: [event()] },
        { ...STATED, set: { when: "2026-11-20T15:00:00Z", until: "2026-11-20T17:00:00Z" } }
      )
    );
    expect(ranged.rows[0]!.attrs.new_value).toEqual({
      start: "2026-11-20T15:00:00.000Z",
      end: "2026-11-20T17:00:00.000Z"
    });
  });

  it("needs a time with an offset, and says what to send", () => {
    for (const bad of ["2026-11-20T15:00:00", "tomorrow", "", "2026-13-40T10:00:00Z"]) {
      const r = refusal(run("redate", "e", { facts: [event()] }, { ...STATED, set: { when: bad } }));
      expect(r.code, bad).toBe("bad_params");
      expect(r.message, bad).toContain("UTC offset");
      expect(r.message, bad).toContain("Nothing was changed");
    }
    expect(refusal(run("redate", "e", { facts: [event()] }, STATED)).code).toBe("bad_params");
  });

  it("is bounded: not before the mail it was read from, not beyond now + 366 days; boundaries are allowed", () => {
    const source = event({ tsStart: ago(3), ingestedAt: ago(3) });
    const before = refusal(run("redate", "e", { facts: [source] }, { ...STATED, set: { when: ago(4) } }));
    expect(before.code).toBe("bad_params");
    expect(before.message).toContain("between");
    expect(refusal(run("redate", "e", { facts: [source] }, { ...STATED, set: { when: ahead(367) } })).code).toBe(
      "bad_params"
    );
    accepted(run("redate", "e", { facts: [source] }, { ...STATED, set: { when: ago(3) } }));
    accepted(run("redate", "e", { facts: [source] }, { ...STATED, set: { when: ahead(366) } }));
  });

  it("bounds until: not before when, at most 7 days after it", () => {
    const set = (until: string) => ({ ...STATED, set: { when, until } });
    expect(refusal(run("redate", "e", { facts: [event()] }, set(ahead(9)))).code).toBe("bad_params");
    expect(refusal(run("redate", "e", { facts: [event()] }, set(ahead(18)))).code).toBe("bad_params");
    accepted(run("redate", "e", { facts: [event()] }, set(ahead(17))));
  });

  it("is refused on an ask or commitment, never a silent no-op", () => {
    const r = refusal(run("redate", "a", { facts: [ask()] }, { ...STATED, set: { when } }));
    expect(r.code).toBe("wrong_type");
    expect(r.message).toContain("event or a deadline");
  });

  it("needs the owner's words, past or future", () => {
    expect(refusal(run("redate", "e", { facts: [event()] }, { set: { when } })).code).toBe("needs_stated");
  });

  it("a redate into the past is allowed with the owner's words and says it leaves the list", () => {
    const source = event({ tsStart: ago(3), ingestedAt: ago(3) });
    const plan = accepted(run("redate", "e", { facts: [source] }, { ...STATED, set: { when: ago(1) } }));
    expect(plan.message).toContain("already past");
  });

  it("is refused when the owner already corrected the time", () => {
    const r = refusal(
      run(
        "redate",
        "e",
        { facts: [event()], overrides: [override("e", "when", { start: ahead(20) }, ago(1), "person")] },
        { ...STATED, set: { when } }
      )
    );
    expect(r.code).toBe("owner_decided");
    expect(r.message).toContain("time");
  });

  it("moves the fact in the fold, and an earlier Mark redate is replaced by a later one", () => {
    const input: FoldInput = { now: NOW, facts: [event()] };
    const row = accepted(run("redate", "e", input, { ...STATED, set: { when } })).rows[0]!.attrs;
    const after = folded(
      { ...input, overrides: [override("e", "when", row.new_value, NOW.toISOString(), "mark")] },
      "e"
    );
    expect(after.dueAt).toBe(when);
  });
});

describe("the owner's word stands", () => {
  const decided = (s: FoldStatus["status"]) => [status("a", s, ago(1), "person")];
  it("refuses confirm, done, ignore and reopen when the owner's status wins, and says what it was", () => {
    for (const action of ["confirm", "done", "ignore", "reopen"]) {
      const r = refusal(run(action, "a", { facts: [ask()], statuses: decided("confirmed") }, STATED));
      expect(r.code, action).toBe("owner_decided");
      expect(r.message, action).toContain("owner already");
      expect(r.message, action).toContain("confirmed");
      expect(r.message, action).not.toMatch(/tell the owner only if/i);
      expect(r.message, action).toContain("Leave it");
    }
    const closed = refusal(run("done", "a", { facts: [ask()], statuses: decided("done") }, STATED));
    expect(closed.code).toBe("owner_decided");
  });

  it("holds when the owner's status was recorded after Mark's with an older valid_from (B5)", () => {
    const mark = status("a", "done", ago(1), "mark", { ingestedAt: ago(1) });
    const person = status("a", "confirmed", ago(4), "person", { ingestedAt: at(-HOUR) });
    const r = refusal(run("reopen", "a", { facts: [ask()], statuses: [mark, person] }));
    expect(r.code).toBe("owner_decided");
  });

  it("an extractor's status is not the owner's: a source_gone fact cannot be reopened by Mark", () => {
    const gone = status("a", "source_gone", ago(1), "extractor");
    const r = refusal(run("reopen", "a", { facts: [ask()], statuses: [gone] }));
    expect(r.code).toBe("no_mark");
  });
});

describe("only an open fact can be acted on", () => {
  it("refuses a fact the owner's reply closed, saying so", () => {
    const r = refusal(
      run("done", "a", { facts: [ask()], conversations: { "gmail:t1": [{ at: ago(1), fromSelf: true }] } }, STATED)
    );
    expect(r.code).toBe("not_open");
    expect(r.message).toContain("replied");
    expect(r.message).toContain('rhen_inbox {"room":"facts"}');
  });

  it("refuses an expired fact and a link row", () => {
    const old = ask({ tsStart: ago(40), ingestedAt: ago(40) });
    const expired = refusal(run("done", "a", { facts: [old] }, STATED));
    expect(expired.code).toBe("not_open");
    expect(expired.message).toContain("expired");
    const target = event({ factId: id("t"), key: "t", tsStart: ago(3), ingestedAt: ago(3) });
    const cancel = event({
      factId: id("c"),
      key: "c",
      tsStart: ago(1),
      ingestedAt: ago(1),
      links: [{ relation: "cancel", targetFactId: id("t") }]
    });
    expect(refusal(run("done", "c", { facts: [target, cancel] }, STATED)).code).toBe("not_open");
  });

  it("names who closed it", () => {
    const r = refusal(
      run("ignore", "a", { facts: [ask()], statuses: [status("a", "done", ago(1), "mark", { by: "other" })] }, STATED)
    );
    expect(r.code).toBe("not_open");
    expect(r.message).toContain("done");
  });
});

describe("reopen (undo of Mark's own mark only)", () => {
  it("writes proposed over Mark's done, and the fold opens again", () => {
    const done = status("a", "done", ago(1), "mark");
    const input: FoldInput = { now: NOW, facts: [ask()], statuses: [done] };
    const plan = accepted(run("reopen", "a", input));
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ kind: "fact_status", attrs: { status: "proposed", act: "reopen" } });
    const row = plan.rows[0]!.attrs;
    expect(
      folded({ ...input, statuses: [done, status("a", "proposed", row.valid_from as string, "mark")] }, "a").open
    ).toBe(true);
  });

  it("takes back a hold too", () => {
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    const hold = status("a", "confirmed", ago(1), "mark", { expiresAt: ahead(10) });
    expect(accepted(run("reopen", "a", { facts: [stale], statuses: [hold] })).rows[0]!.attrs.status).toBe("proposed");
  });

  it("restores the extractor's time after Mark's redate (one call undoes the mark)", () => {
    const original = { candidates: [{ start: ahead(5) }], ambiguous: false };
    const input: FoldInput = {
      now: NOW,
      facts: [event({ when: original })],
      overrides: [override("e", "when", { start: ago(1) }, ago(1), "mark")]
    };
    expect(folded(input, "e").state).toBe("expired");
    const plan = accepted(run("reopen", "e", input));
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({
      kind: "override",
      attrs: { field: "when", new_value: original, act: "reopen" }
    });
    const after = folded(
      { ...input, overrides: [...input.overrides!, override("e", "when", original, NOW.toISOString(), "mark")] },
      "e"
    );
    expect(after).toMatchObject({ open: true, dueAt: new Date(Date.parse(ahead(5))).toISOString() });
  });

  it("writes null when the extractor read no time", () => {
    const input: FoldInput = {
      now: NOW,
      facts: [event({ when: null })],
      overrides: [override("e", "when", { start: ahead(3) }, ago(1), "mark")]
    };
    expect(accepted(run("reopen", "e", input)).rows[0]!.attrs.new_value).toBeNull();
  });

  it("can act on an item that is expired only because of Mark's own redate, and a corrective redate is allowed there (B3)", () => {
    const input: FoldInput = {
      now: NOW,
      facts: [event({ tsStart: ago(3), ingestedAt: ago(3) })],
      overrides: [override("e", "when", { start: ago(1) }, ago(1), "mark")]
    };
    expect(folded(input, "e").state).toBe("expired");
    accepted(run("redate", "e", input, { ...STATED, set: { when: ahead(2) } }));
    accepted(run("reopen", "e", input));
    // ...but not an item that expired on its own.
    const natural = refusal(
      run(
        "redate",
        "e",
        { facts: [event({ tsStart: ago(40), ingestedAt: ago(40), when: null })] },
        { ...STATED, set: { when: ahead(2) } }
      )
    );
    expect(natural.code).toBe("not_open");
  });

  it("writes both rows when a done and a redate are both Mark's", () => {
    const original = { candidates: [{ start: ahead(5) }], ambiguous: false };
    const input: FoldInput = {
      now: NOW,
      facts: [event({ when: original })],
      statuses: [status("e", "done", ago(1), "mark")],
      overrides: [override("e", "when", { start: ahead(9) }, ago(1), "mark")]
    };
    expect(
      accepted(run("reopen", "e", input))
        .rows.map((r) => r.kind)
        .sort()
    ).toEqual(["fact_status", "override"]);
  });

  it("refuses when Mark has no mark on it, with the state", () => {
    const r = refusal(run("reopen", "a", { facts: [ask()] }));
    expect(r.code).toBe("no_mark");
    expect(r.message).toContain("no mark");
    expect(r.message).toContain("Nothing was changed");
  });

  it("refuses another agent's mark", () => {
    const done = status("a", "done", ago(1), "mark", { by: "someone-else" });
    expect(refusal(run("reopen", "a", { facts: [ask()], statuses: [done] })).code).toBe("no_mark");
  });

  it("does not resurrect an ask the owner already answered (S6)", () => {
    const done = status("a", "done", ago(1), "mark");
    const conversations = { "gmail:t1": [{ at: at(-3 * HOUR), fromSelf: true }] };
    const input: FoldInput = { now: NOW, facts: [ask()], statuses: [done], conversations };
    const r = refusal(run("reopen", "a", input));
    expect(r.code).toBe("answered");
    expect(r.message).toContain("replied");
    expect(r.message).toContain("Nothing was changed");
  });

  it("an owner's reply to a mail that is not an ask does not matter", () => {
    const input: FoldInput = {
      now: NOW,
      facts: [ask({ factType: "commitment" })],
      statuses: [status("a", "done", ago(1), "mark")],
      conversations: { "gmail:t1": [{ at: at(-3 * HOUR), fromSelf: true }] }
    };
    accepted(run("reopen", "a", input));
  });
});

describe("valid_from is strictly increasing per fact", () => {
  it("never ties with an existing status, even the owner's at this very instant", () => {
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    const same = status("a", "proposed", NOW.toISOString(), "mark", { ingestedAt: NOW.toISOString() });
    const plan = accepted(run("confirm", "a", { facts: [stale], statuses: [same] }));
    expect(Date.parse(plan.rows[0]!.attrs.valid_from as string)).toBe(NOW.getTime() + 1);
  });
});

describe("rate limits", () => {
  const closing = (n: number, minutesAgo: (i: number) => number, by = MARK): FoldStatus[] =>
    Array.from({ length: n }, (_, i) =>
      status(`f${i}`, "done", at(-minutesAgo(i) * 60_000), "mark", { by, act: "done" })
    );
  const facts = [ask(), ...Array.from({ length: 20 }, (_, i) => ask({ key: `k${i}`, factId: id(`f${i}`) }))];

  it("refuses the 6th closing in an hour with the time the oldest leaves the window", () => {
    const r = refusal(run("done", "a", { facts, statuses: closing(5, (i) => 10 + i * 10) }, STATED));
    expect(r.code).toBe("rate");
    expect(r.message).toContain("5");
    // the oldest of the five is 50 minutes old, so it leaves the hour in 10 minutes
    expect(r.message).toContain("Try again after");
    expect(r.message).toContain(minute(NOW.getTime() + 10 * 60_000));
  });

  it("allows the 5th, counts ignore and redate with done, and does not count another agent", () => {
    accepted(run("done", "a", { facts, statuses: closing(4, (i) => 10 + i * 10) }, STATED));
    refusal(run("ignore", "a", { facts, statuses: closing(5, (i) => 10 + i * 10) }, STATED));
    accepted(run("done", "a", { facts, statuses: closing(5, (i) => 10 + i * 10, "other-agent") }, STATED));
    const redated = override("f9", "when", { start: ahead(3) }, at(-5 * 60_000), "mark", { act: "redate" });
    const input = {
      facts: [...facts, event({ factId: id("f9"), key: "f9" })],
      statuses: closing(4, (i) => 10 + i * 10),
      overrides: [redated]
    };
    expect(refusal(run("done", "a", input, STATED)).code).toBe("rate");
  });

  it("a reopen restoring a time is not a closing", () => {
    const rows = closing(4, (i) => 10 + i * 10);
    const restore = override("f9", "when", null, at(-5 * 60_000), "mark", { act: "reopen" });
    accepted(
      run(
        "done",
        "a",
        { facts: [...facts, event({ factId: id("f9"), key: "f9" })], statuses: rows, overrides: [restore] },
        STATED
      )
    );
  });

  it("limits closings to 15 in a rolling day", () => {
    const rows = closing(15, (i) => 120 + i * 60); // all older than an hour, newest 2 h ago, oldest ~16 h ago
    const r = refusal(run("done", "a", { facts, statuses: rows }, STATED));
    expect(r.code).toBe("rate");
    expect(r.message).toContain("day");
    expect(r.message).toContain(minute(NOW.getTime() - (120 + 14 * 60) * 60_000 + 24 * HOUR));
    accepted(run("done", "a", { facts, statuses: closing(14, (i) => 120 + i * 60) }, STATED));
  });

  it("limits all writes to 10 an hour, and never counts confirm or reopen as closings", () => {
    const holds = Array.from({ length: 10 }, (_, i) =>
      status(`f${i % 20}`, "confirmed", at(-(i + 1) * 60_000), "mark", { by: MARK, act: "confirm" })
    );
    const stale = ask({ tsStart: ago(13), ingestedAt: ago(13) });
    const r = refusal(run("confirm", "a", { facts: [stale, ...facts.slice(1)], statuses: holds }));
    expect(r.code).toBe("rate");
    expect(accepted(run("confirm", "a", { facts: [stale, ...facts.slice(1)], statuses: holds.slice(1) })).ok).toBe(
      true
    );
  });
});

describe("limits counted from the write ledger (history)", () => {
  const entry = (act: string, minutesAgo: number, factId: string | null = null) => ({
    at: at(-minutesAgo * 60_000),
    act,
    factId
  });
  const withHistory = (action: string, history: ReturnType<typeof entry>[], over: Partial<FactActInput> = {}) =>
    planFactAct({
      action,
      factId: id("a"),
      by: MARK,
      now: NOW,
      set: {},
      fold: { now: NOW, facts: [ask()] },
      history,
      ...STATED,
      ...over
    });

  it("counts marks the fold no longer shows, so an undone closing still uses its place", () => {
    const five = Array.from({ length: FACT_CLOSINGS_PER_HOUR }, (_, i) => entry("done", i + 1));
    const r = withHistory("done", five);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe("rate");
    expect(withHistory("done", five.slice(1)).ok).toBe(true);
  });

  it("limits the day to 15 closings however they are spread", () => {
    const fifteen = Array.from({ length: FACT_CLOSINGS_PER_DAY }, (_, i) => entry("ignore", 90 + i * 60));
    const r = withHistory("ignore", fifteen);
    expect(!r.ok && r.code).toBe("rate");
  });

  it("holds a fact open once a day", () => {
    const r = withHistory("confirm", [entry("confirm", 60, id("a"))]);
    expect(!r.ok && r.code).toBe("rate");
    expect(withHistory("confirm", [entry("confirm", 60, id("b"))]).ok).toBe(true);
    expect(withHistory("confirm", [entry("confirm", 25 * 60, id("a"))]).ok).toBe(true);
  });
});

describe("no mail text in any answer", () => {
  it("names an item by type and short id only", () => {
    const text = accepted(run("done", "a", { facts: [ask()] }, STATED)).message;
    expect(text).toContain("ask a0000000");
    expect(text).not.toContain(STATED.evidence);
  });
});

describe("agentMarks (what an agent can still take back)", () => {
  it("lists this agent's standing marks, newest first, whatever their age, and nothing of the owner's or another agent's", () => {
    const input: FoldInput = {
      now: NOW,
      facts: [
        ask({ tsStart: ago(40), ingestedAt: ago(40) }),
        ask({ key: "b", factId: id("b") }),
        ask({ key: "c", factId: id("c") }),
        event()
      ],
      statuses: [
        status("a", "done", ago(30), "mark", { act: "done" }),
        status("b", "confirmed", ago(2), "mark", { act: "confirm", expiresAt: ahead(5) }),
        status("c", "done", ago(1), "mark", { by: "other", act: "done" })
      ],
      overrides: [override("e", "when", { start: ahead(9) }, ago(1), "mark", { act: "redate" })]
    };
    const marks = agentMarks(input, MARK);
    expect(marks.map((m) => [m.factId, m.act])).toEqual([
      [id("e"), "redate"],
      [id("b"), "confirm"],
      [id("a"), "done"]
    ]);
    expect(marks.find((m) => m.factId === id("a"))!.open).toBe(false);
  });

  it("leaves out a mark that was taken back or overruled", () => {
    const input: FoldInput = {
      now: NOW,
      facts: [ask()],
      statuses: [status("a", "done", ago(3), "mark"), status("a", "proposed", ago(2), "mark", { act: "reopen" })]
    };
    expect(agentMarks(input, MARK)).toEqual([]);
    expect(
      agentMarks(
        { ...input, statuses: [status("a", "done", ago(3), "mark"), status("a", "confirmed", ago(2), "person")] },
        MARK
      )
    ).toEqual([]);
  });
});
