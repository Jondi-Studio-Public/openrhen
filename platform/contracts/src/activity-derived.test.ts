import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DERIVED_ATTRS_MAX_BYTES,
  DERIVED_FACT_LABEL_FIELDS,
  DERIVED_FACT_STATUSES,
  DERIVED_FACT_TYPES,
  DERIVED_COMPUTED_REVIEW_REASONS,
  DERIVED_CONTENT_MAX_CODE_POINTS,
  DERIVED_FACT_ATTR_KEYS,
  DERIVED_DIRECTIONS,
  DERIVED_LINK_RELATIONS,
  DERIVED_MAX_LINKS,
  DERIVED_MAX_WHEN_CANDIDATES,
  DERIVED_MAX_WHO,
  DERIVED_MESSAGE_LABEL_FIELDS,
  DERIVED_SPAN_MAX_CODE_POINTS,
  DERIVED_STORED_REVIEW_REASONS,
  DERIVED_MSG_CLASSES,
  DERIVED_MSG_CLASS_REASONS,
  describeDerivedProblem
} from "./activity-derived.js";
import { validateActivityEvent } from "./activity-events.js";

const FACT_ID = "a".repeat(40);
const NOW = new Date("2026-11-08T00:00:00Z");

describe("the closed vocabularies", () => {
  it("pins the values the plan froze", () => {
    expect(DERIVED_FACT_STATUSES).toEqual([
      "proposed",
      "confirmed",
      "rescheduled",
      "cancelled",
      "done",
      "superseded",
      "source_gone"
    ]);
    expect(DERIVED_MSG_CLASSES).toEqual(["person", "bulk", "automated", "transaction", "calendar"]);
    expect(DERIVED_FACT_TYPES).toEqual(["ask", "commitment", "event", "deadline"]);
    expect(DERIVED_MSG_CLASS_REASONS).not.toContain("no_headers");
  });
});

/** The extractor attrs every msg_class and fact row must carry. */
const EXT = { extractor: "msg-class-t0", extractor_version: "1" };

describe("describeDerivedProblem", () => {
  it("accepts a well-formed row of every kind", () => {
    expect(
      describeDerivedProblem(
        "msg_class",
        { ...EXT, source_event_id: "g1", class: "bulk", reasons: ["list_id"], tier: "t0" },
        null
      )
    ).toBeNull();
    expect(
      describeDerivedProblem(
        "fact",
        { ...EXT, source_event_id: "g1", fact_id: FACT_ID, fact_type: "ask", confidence: 0.5 },
        null
      )
    ).toBeNull();
    expect(
      describeDerivedProblem(
        "fact_status",
        { fact_id: FACT_ID, status: "done", valid_from: "2026-11-08T01:00:00Z" },
        null
      )
    ).toBeNull();
    expect(describeDerivedProblem("override", { fact_id: FACT_ID, field: "when", new_value: "x" }, null)).toBeNull();
    expect(describeDerivedProblem("label", { fact_id: FACT_ID, field: "fact_type", answer: "ask" }, null)).toBeNull();
  });

  it("accepts an expires_at on a status (it holds an ask open) and rejects one that is not a real RFC 3339 time", () => {
    const base = { fact_id: FACT_ID, status: "confirmed", valid_from: "2026-11-08T01:00:00Z" };
    expect(describeDerivedProblem("fact_status", { ...base, expires_at: "2026-12-08T01:00:00Z" }, null)).toBeNull();
    for (const bad of ["soon", "2026-12-08", "2026-13-40T00:00:00Z", 5]) {
      const problem = describeDerivedProblem("fact_status", { ...base, expires_at: bad }, null);
      expect(problem, String(bad)).toContain("attrs.expires_at");
      expect(problem).toContain("RFC 3339");
    }
  });

  it("refuses an expires_at outside 0 to 90 days after valid_from, or on a status that cannot hold, saying the limit and the fix", () => {
    const base = { fact_id: FACT_ID, status: "confirmed", valid_from: "2026-11-08T01:00:00Z" };
    for (const far of ["2199-01-01T00:00:00Z", "3000-01-01T00:00:00Z", "2027-03-01T00:00:00Z"]) {
      const problem = describeDerivedProblem("fact_status", { ...base, expires_at: far }, null);
      expect(problem, far).toContain("90 days");
      expect(problem).toContain("2027-02-06T01:00:00.000Z");
    }
    const past = describeDerivedProblem("fact_status", { ...base, expires_at: "2020-01-01T00:00:00Z" }, null);
    expect(past).toContain("before valid_from");
    expect(describeDerivedProblem("fact_status", { ...base, expires_at: "2027-02-06T01:00:00Z" }, null)).toBeNull();
    expect(
      describeDerivedProblem(
        "fact_status",
        { ...base, status: "rescheduled", expires_at: "2026-12-01T00:00:00Z" },
        null
      )
    ).toBeNull();
    for (const status of ["done", "proposed", "cancelled"]) {
      const problem = describeDerivedProblem(
        "fact_status",
        { ...base, status, expires_at: "2026-12-01T00:00:00Z" },
        null
      );
      expect(problem, status).toContain("only on a confirmed or rescheduled status");
    }
  });

  it("rejects an unknown fact_status and names the allowed values and the fix", () => {
    const problem = describeDerivedProblem(
      "fact_status",
      { fact_id: FACT_ID, status: "finished", valid_from: "2026-11-08T01:00:00Z" },
      null
    );
    expect(problem).toContain('"finished"');
    for (const status of DERIVED_FACT_STATUSES) expect(problem).toContain(status);
    expect(problem).toContain("Send");
  });

  it("rejects an extract_failed status, which the plan keeps out of fact_status", () => {
    expect(
      describeDerivedProblem(
        "fact_status",
        { fact_id: FACT_ID, status: "extract_failed", valid_from: "2026-11-08T01:00:00Z" },
        null
      )
    ).toContain("Use one of");
  });

  it("rejects an unknown reason code and an unknown class, naming the allowed values", () => {
    const reason = describeDerivedProblem(
      "msg_class",
      { ...EXT, source_event_id: "g1", class: "bulk", reasons: ["looks_spammy"] },
      null
    );
    expect(reason).toContain('"looks_spammy"');
    for (const code of DERIVED_MSG_CLASS_REASONS) expect(reason).toContain(code);
    const cls = describeDerivedProblem(
      "msg_class",
      { ...EXT, source_event_id: "g1", class: "spam", reasons: [] },
      null
    );
    for (const name of DERIVED_MSG_CLASSES) expect(cls).toContain(name);
  });

  it("says unknown is never stored, rather than listing it as a class", () => {
    const problem = describeDerivedProblem(
      "msg_class",
      { ...EXT, source_event_id: "g1", class: "unknown", reasons: [] },
      null
    );
    expect(problem).toContain("unknown");
    expect(problem).toContain("Do not write");
  });

  it("rejects a client-supplied by on every derived kind, saying the server sets it", () => {
    for (const kind of ["msg_class", "fact", "fact_status", "override", "label", "correction"]) {
      const problem = describeDerivedProblem(kind, { by: "person" }, null);
      expect(problem, kind).toContain("attrs.by");
      expect(problem, kind).toContain("Remove");
    }
  });

  it("rejects a bad fact_id, fact_type, tier and confidence with the fix", () => {
    expect(
      describeDerivedProblem("fact", { ...EXT, source_event_id: "g", fact_id: "XYZ", fact_type: "ask" }, null)
    ).toContain("40 lowercase hex");
    const type = describeDerivedProblem(
      "fact",
      { ...EXT, source_event_id: "g", fact_id: FACT_ID, fact_type: "invite" },
      null
    );
    for (const name of DERIVED_FACT_TYPES) expect(type).toContain(name);
    expect(
      describeDerivedProblem(
        "msg_class",
        { ...EXT, source_event_id: "g", class: "bulk", reasons: [], tier: "t9" },
        null
      )
    ).toContain("t0");
    expect(
      describeDerivedProblem(
        "fact",
        { ...EXT, source_event_id: "g", fact_id: FACT_ID, fact_type: "ask", confidence: 2 },
        null
      )
    ).toContain("between 0 and 1");
  });

  it("rejects an impossible calendar date in valid_from, and a duplicate reason", () => {
    for (const bad of ["2026-13-45T99:99:99Z", "2026-02-30T10:00:00Z", "2026-11-08T25:00:00Z"])
      expect(
        describeDerivedProblem("fact_status", { fact_id: FACT_ID, status: "done", valid_from: bad }, null),
        bad
      ).toContain("valid_from");
    expect(
      describeDerivedProblem(
        "msg_class",
        { ...EXT, source_event_id: "g", class: "bulk", reasons: ["list_id", "list_id"] },
        null
      )
    ).toContain("more than once");
  });

  it("requires the fields each kind needs", () => {
    expect(describeDerivedProblem("fact_status", { status: "done" }, null)).toContain("fact_id");
    expect(describeDerivedProblem("fact_status", { fact_id: FACT_ID, status: "done" }, null)).toContain("valid_from");
    expect(describeDerivedProblem("override", { fact_id: FACT_ID, new_value: 1 }, null)).toContain("field");
    expect(describeDerivedProblem("label", { answer: "x" }, null)).toContain("fact_id");
    expect(describeDerivedProblem("msg_class", { class: "bulk", reasons: [] }, null)).toContain("source_event_id");
  });

  it("takes null as an answer ('no such value') but not a missing answer", () => {
    const ok = { fact_id: FACT_ID, field: "fact_type" };
    expect(describeDerivedProblem("label", { ...ok, answer: null }, null)).toBeNull();
    const missing = describeDerivedProblem("label", ok, null);
    expect(missing).toContain("attrs.answer is missing");
    expect(missing).toContain("null");
  });

  it("requires a label's field and checks it against the attrs of what is labelled, naming the allowed fields", () => {
    const fact = { fact_id: FACT_ID, answer: "ask" };
    const missing = describeDerivedProblem("label", fact, null);
    expect(missing).toContain("attrs.field is missing");
    expect(missing).toContain("fact_type");
    expect(describeDerivedProblem("label", { ...fact, field: "fact_type" }, null)).toBeNull();
    const badFact = describeDerivedProblem("label", { ...fact, field: "class" }, null);
    expect(badFact).toContain('"class"');
    for (const allowed of DERIVED_FACT_LABEL_FIELDS) expect(badFact).toContain(allowed);
    const message = { source_event_id: "g1", answer: "bulk" };
    expect(describeDerivedProblem("label", { ...message, field: "class" }, null)).toBeNull();
    expect(describeDerivedProblem("label", { ...message, field: "reasons" }, null)).toBeNull();
    const badMessage = describeDerivedProblem("label", { ...message, field: "fact_type" }, null);
    for (const allowed of DERIVED_MESSAGE_LABEL_FIELDS) expect(badMessage).toContain(allowed);
    expect(describeDerivedProblem("label", { ...message, field: 5 }, null)).toContain("attrs.field");
  });

  it("checks the optional slice and stratum of a label, naming the allowed values", () => {
    const ok = { fact_id: FACT_ID, answer: "ask", field: "fact_type" };
    expect(describeDerivedProblem("label", { ...ok, slice: "random", stratum: "t0_flag" }, null)).toBeNull();
    const slice = describeDerivedProblem("label", { ...ok, slice: "all" }, null);
    expect(slice).toContain("random, stratified");
    expect(slice).toContain('"all"');
    expect(describeDerivedProblem("label", { ...ok, stratum: "x".repeat(61) }, null)).toContain("attrs.stratum");
  });

  it("states the size rule and refuses a body", () => {
    const big = {
      source_event_id: "g1",
      class: "bulk",
      reasons: [],
      pad: "x".repeat(ACTIVITY_DERIVED_ATTRS_MAX_BYTES)
    };
    expect(describeDerivedProblem("msg_class", big, null)).toContain(String(ACTIVITY_DERIVED_ATTRS_MAX_BYTES));
    expect(
      describeDerivedProblem("msg_class", { source_event_id: "g1", class: "bulk", reasons: [] }, "hello")
    ).toContain("content");
  });
});

describe("applied at ingest", () => {
  const base = { id: "k1", source: "derived", start: "2026-11-08T00:00:00Z" };

  it("rejects a bad derived row through validateActivityEvent and accepts a good one", () => {
    const bad = validateActivityEvent(
      { ...base, kind: "fact_status", attrs: { fact_id: FACT_ID, status: "finished", valid_from: base.start } },
      NOW
    );
    expect(bad.ok).toBe(false);
    const good = validateActivityEvent(
      { ...base, kind: "fact_status", attrs: { fact_id: FACT_ID, status: "done", valid_from: base.start } },
      NOW
    );
    expect(good.ok).toBe(true);
  });

  it("leaves other sources alone", () => {
    expect(
      validateActivityEvent({ id: "k", source: "gmail", kind: "message", start: base.start, attrs: { by: "x" } }, NOW)
        .ok
    ).toBe(true);
  });
});

describe("extractor and extractor_version on msg_class and fact", () => {
  const msg = (extra: Record<string, unknown>) =>
    describeDerivedProblem("msg_class", { source_event_id: "g1", class: "bulk", reasons: ["list_id"], ...extra }, null);
  const fact = (extra: Record<string, unknown>) =>
    describeDerivedProblem("fact", { source_event_id: "g", fact_id: FACT_ID, fact_type: "ask", ...extra }, null);

  it("accepts both together, or neither", () => {
    expect(msg({ extractor: "msg-class-t0", extractor_version: "1" })).toBeNull();
    expect(fact({ extractor: "ask-t2", extractor_version: "2.1-beta" })).toBeNull();
  });

  it("requires both on msg_class and fact, naming the fix, since reads show only the active version's rows", () => {
    for (const problem of [msg({}), fact({})]) {
      expect(problem).toContain("attrs.extractor");
      expect(problem).toContain("attrs.extractor_version");
      expect(problem).toContain("msg-class-t0");
    }
  });

  it("refuses one without the other, naming the fix", () => {
    expect(msg({ extractor: "msg-class-t0" })).toContain("attrs.extractor_version");
    expect(msg({ extractor_version: "1" })).toContain("attrs.extractor");
    expect(fact({ extractor_version: "1" })).toContain("attrs.extractor");
  });

  it("refuses names and versions that are not plain identifiers", () => {
    for (const extractor of ["", "Msg Class", "a".repeat(61), 7, null, "-lead"])
      expect(msg({ extractor, extractor_version: "1" }), String(extractor)).toContain("attrs.extractor ");
    for (const extractor_version of ["", "v 1", "1".repeat(21), 1, null, ".1"])
      expect(msg({ extractor: "msg-class-t0", extractor_version }), String(extractor_version)).toContain(
        "attrs.extractor_version"
      );
  });
});

describe("the fact attrs a 2b extractor writes", () => {
  const SPAN = { start: 10, end: 42, hash: "0123456789ab" };
  const WHEN = {
    raw: [50, 56],
    ref_time: "2026-11-08T01:00:00Z",
    tz: "Australia/Sydney",
    candidates: [{ start: "2026-11-13T09:00:00+11:00" }],
    ambiguous: false
  };
  const MODEL = { id: "qwen3:14b", digest: "a1b2c3d4e5f6" };
  const fact = (extra: Record<string, unknown>) =>
    describeDerivedProblem(
      "fact",
      { ...EXT, extractor: "fact-llm", source_event_id: "g1", fact_id: FACT_ID, fact_type: "ask", ...extra },
      null
    );

  it("pins the vocabularies the plan froze", () => {
    expect(DERIVED_DIRECTIONS).toEqual(["in", "out"]);
    expect(DERIVED_LINK_RELATIONS).toEqual(["cancel", "reschedule", "repeat"]);
    expect(DERIVED_STORED_REVIEW_REASONS).toEqual(["ambiguous_date", "unmatched_update", "over_cap", "low_signal"]);
    expect(DERIVED_COMPUTED_REVIEW_REASONS).toEqual(["expired", "update_seen", "t3_deferred"]);
    expect(DERIVED_MESSAGE_LABEL_FIELDS).toEqual(["class", "reasons", "tier", "fact_types", "sensitive"]);
    expect(DERIVED_MAX_WHO).toBe(3);
    expect(DERIVED_MAX_WHEN_CANDIDATES).toBe(3);
    expect(DERIVED_MAX_LINKS).toBe(3);
    expect(DERIVED_SPAN_MAX_CODE_POINTS).toBe(200);
  });

  it("accepts a complete model fact, an inbound one, and a bare 2a fact", () => {
    expect(
      fact({
        tier: "t2",
        span: SPAN,
        when: WHEN,
        who: ["alex@example.test"],
        direction: "in",
        conversation_key: "gmail:18c0ffee12345678",
        model: MODEL,
        review_reason: "low_signal"
      })
    ).toBeNull();
    expect(fact({ direction: "out", who: ["a@example.test", "b@example.test", "c@example.test"] })).toBeNull();
    expect(fact({})).toBeNull();
  });

  it("accepts an ICS fact with a uid and no span, and a link row", () => {
    expect(fact({ tier: "t0", ics_uid: "uid-1@example.test", extractor: "fact-ics" })).toBeNull();
    expect(
      fact({ links: [{ relation: "cancel", target_fact_id: "b".repeat(40) }], when: { ...WHEN, raw: undefined } })
    ).toBeNull();
  });

  describe("span", () => {
    it("rejects a non-object, a missing part, and offsets that are not a forward range", () => {
      expect(fact({ span: "quote text" })).toContain("attrs.span");
      expect(fact({ span: { start: 1, end: 5 } })).toContain("hash");
      expect(fact({ span: { ...SPAN, start: -1 } })).toContain("whole number");
      expect(fact({ span: { ...SPAN, start: 1.5 } })).toContain("whole number");
      expect(fact({ span: { ...SPAN, start: 5, end: 5 } })).toContain("end must be greater than start");
      expect(fact({ span: { ...SPAN, hash: "xyz" } })).toContain("12 lowercase hex");
      expect(fact({ span: { ...SPAN, text: "the quote" } })).toContain('"text"');
    });
    it("rejects a span longer than a quote may be, naming the limit", () => {
      const problem = fact({ span: { ...SPAN, start: 0, end: DERIVED_SPAN_MAX_CODE_POINTS + 1 } });
      expect(problem).toContain(String(DERIVED_SPAN_MAX_CODE_POINTS));
      expect(fact({ tier: "t1", span: { ...SPAN, start: 0, end: DERIVED_SPAN_MAX_CODE_POINTS } })).toBeNull();
    });
  });

  describe("when", () => {
    it("rejects a missing part, a bad zone and a bad time", () => {
      expect(fact({ when: "Friday" })).toContain("attrs.when");
      expect(fact({ when: { ...WHEN, ref_time: undefined } })).toContain("ref_time");
      expect(fact({ when: { ...WHEN, ref_time: "2026-02-30T10:00:00Z" } })).toContain("ref_time");
      expect(fact({ when: { ...WHEN, tz: "Mars/Olympus" } })).toContain("IANA");
      expect(fact({ when: { ...WHEN, ambiguous: "yes" } })).toContain("true or false");
      expect(fact({ when: { ...WHEN, candidates: [{ start: "next friday" }] } })).toContain("candidates[0].start");
      expect(fact({ when: { ...WHEN, candidates: "x" } })).toContain("candidates");
    });
    it("keeps raw as two offsets, never text", () => {
      expect(fact({ when: { ...WHEN, raw: "next Friday" } })).toContain("two offsets");
      expect(fact({ when: { ...WHEN, raw: [9, 3] } })).toContain("two offsets");
      expect(fact({ when: { ...WHEN, raw: [1, 2, 3] } })).toContain("two offsets");
    });
    it("allows at most 3 candidates and says a resolved time has exactly one", () => {
      const four = Array.from({ length: 4 }, (_, i) => ({ start: `2026-11-1${i}T09:00:00Z` }));
      expect(fact({ when: { ...WHEN, ambiguous: true, candidates: four } })).toContain("at most 3");
      expect(fact({ when: { ...WHEN, ambiguous: true, candidates: four.slice(0, 3) } })).toBeNull();
      expect(fact({ when: { ...WHEN, ambiguous: true, candidates: [] } })).toBeNull();
      const none = fact({ when: { ...WHEN, ambiguous: false, candidates: [] } });
      expect(none).toContain("ambiguous");
      expect(none).toContain("exactly one");
    });
    it("rejects an unknown key", () => {
      expect(fact({ when: { ...WHEN, text: "Friday" } })).toContain('"text"');
    });
  });

  describe("direction and who", () => {
    it("rejects an unknown direction, naming the values and that the bridge decides", () => {
      const problem = fact({ direction: "inbound" });
      expect(problem).toContain('"inbound"');
      for (const direction of DERIVED_DIRECTIONS) expect(problem).toContain(direction);
      expect(problem).toContain("from_self");
    });
    it("needs a direction to read who, and holds exactly the sender for in", () => {
      expect(fact({ who: ["a@example.test"] })).toContain("attrs.direction");
      expect(fact({ direction: "in", who: ["a@example.test", "b@example.test"] })).toContain("exactly one");
      expect(fact({ direction: "in", who: [] })).toContain("exactly one");
    });
    it("holds 1 to 3 recipients for out", () => {
      expect(fact({ direction: "out", who: [] })).toContain("1 to 3");
      const four = ["a", "b", "c", "d"].map((n) => `${n}@example.test`);
      expect(fact({ direction: "out", who: four })).toContain("1 to 3");
    });
    it("rejects a non-list, a non-text entry, a blank or oversize entry and a repeat", () => {
      expect(fact({ direction: "out", who: "a@example.test" })).toContain("attrs.who");
      expect(fact({ direction: "out", who: [5] })).toContain("attrs.who[0]");
      expect(fact({ direction: "out", who: ["  "] })).toContain("attrs.who[0]");
      expect(fact({ direction: "out", who: ["x".repeat(255)] })).toContain("254");
      expect(fact({ direction: "out", who: ["a@example.test", "a@example.test"] })).toContain("more than once");
      expect(fact({ direction: "in", who: ["a@example.test\nBcc: x"] })).toContain("attrs.who[0]");
    });
  });

  describe("conversation_key and ics_uid", () => {
    it("takes gmail:<thread id> only, and says so", () => {
      const problem = fact({ conversation_key: "thread-1" });
      expect(problem).toContain('"thread-1"');
      expect(problem).toContain("gmail:");
      expect(fact({ conversation_key: "gmail:" })).toContain("gmail:");
      expect(fact({ conversation_key: "gmail:a b" })).toContain("gmail:");
      expect(fact({ conversation_key: 7 })).toContain("attrs.conversation_key");
    });
    it("takes a printable uid of 1 to 255 characters", () => {
      expect(fact({ ics_uid: "" })).toContain("attrs.ics_uid");
      expect(fact({ ics_uid: "u".repeat(256) })).toContain("255");
      expect(fact({ ics_uid: "a\tb" })).toContain("attrs.ics_uid");
      expect(fact({ ics_uid: 3 })).toContain("attrs.ics_uid");
    });
  });

  describe("links", () => {
    it("accepts the three relations and no other", () => {
      for (const relation of DERIVED_LINK_RELATIONS)
        expect(fact({ links: [{ relation, target_fact_id: "b".repeat(40) }] })).toBeNull();
      const problem = fact({ links: [{ relation: "update", target_fact_id: "b".repeat(40) }] });
      expect(problem).toContain('"update"');
      for (const relation of DERIVED_LINK_RELATIONS) expect(problem).toContain(relation);
    });
    it("rejects a bad target, a self link, a repeat, too many, and an empty list", () => {
      expect(fact({ links: [{ relation: "cancel", target_fact_id: "nope" }] })).toContain("40 lowercase hex");
      expect(fact({ links: [{ relation: "cancel", target_fact_id: FACT_ID }] })).toContain("itself");
      const link = { relation: "cancel", target_fact_id: "b".repeat(40) };
      expect(fact({ links: [link, link] })).toContain("more than once");
      const many = ["b", "c", "d", "e"].map((c) => ({ relation: "repeat", target_fact_id: c.repeat(40) }));
      expect(fact({ links: many })).toContain("at most 3");
      expect(fact({ links: [] })).toContain("attrs.links");
      expect(fact({ links: "cancel" })).toContain("attrs.links");
      expect(fact({ links: [{ relation: "cancel", target_fact_id: "b".repeat(40), note: "x" }] })).toContain('"note"');
    });
  });

  describe("model", () => {
    it("is required on a t2 or t3 fact and refused on t0", () => {
      expect(fact({ tier: "t2", span: SPAN })).toContain("attrs.model");
      expect(fact({ tier: "t3", span: SPAN })).toContain("attrs.model");
      expect(fact({ tier: "t0", model: MODEL })).toContain("t0");
    });
    it("is required to carry a span on a model tier, since a quote that does not ground is not written", () => {
      const problem = fact({ tier: "t2", model: MODEL });
      expect(problem).toContain("attrs.span");
      expect(problem).toContain("grounded");
    });
    it("rejects a malformed id, digest or extra key", () => {
      expect(fact({ model: "qwen3" })).toContain("attrs.model");
      expect(fact({ model: { digest: "abc" } })).toContain("attrs.model.id");
      expect(fact({ model: { id: "has space" } })).toContain("attrs.model.id");
      expect(fact({ model: { id: "m", digest: "" } })).toContain("attrs.model.digest");
      expect(fact({ model: { id: "m", key: "secret" } })).toContain('"key"');
    });
  });

  describe("review_reason", () => {
    it("accepts exactly the four stored codes", () => {
      for (const code of DERIVED_STORED_REVIEW_REASONS) expect(fact({ review_reason: code })).toBeNull();
    });
    it("rejects each computed code, saying it is worked out at read and never stored", () => {
      for (const code of DERIVED_COMPUTED_REVIEW_REASONS) {
        const problem = fact({ review_reason: code });
        expect(problem).toContain(`"${code}"`);
        expect(problem).toContain("computed");
        expect(problem).toContain("Remove attrs.review_reason");
        for (const stored of DERIVED_STORED_REVIEW_REASONS) expect(problem).toContain(stored);
      }
    });
    it("rejects an unknown code with the stored list", () => {
      const problem = fact({ review_reason: "ungrounded" });
      for (const stored of DERIVED_STORED_REVIEW_REASONS) expect(problem).toContain(stored);
      expect(fact({ review_reason: 4 })).toContain("attrs.review_reason");
    });
  });

  describe("tier", () => {
    it("is required on a fact that carries a span or a model, naming the tiers", () => {
      const span = fact({ span: SPAN });
      expect(span).toContain("attrs.tier");
      for (const tier of ["t0", "t1", "t2", "t3"]) expect(span).toContain(tier);
      expect(fact({ model: MODEL })).toContain("attrs.tier");
    });
    it("refuses a model on t1, which is not a model tier, and accepts a span on t1", () => {
      const problem = fact({ tier: "t1", model: MODEL, span: SPAN });
      expect(problem).toContain("t1");
      expect(problem).toContain("t2 or t3");
      expect(fact({ tier: "t1", span: SPAN })).toBeNull();
    });
  });

  describe("the closed key set", () => {
    it("refuses a key that could carry free text, naming the allowed keys", () => {
      for (const key of ["quote", "evidence", "needs_review", "review_reasons", "text", "note", "body"]) {
        const problem = fact({ [key]: "Can you send the report by Friday?" });
        expect(problem, key).toContain(`"${key}"`);
        for (const allowed of DERIVED_FACT_ATTR_KEYS) expect(problem, key).toContain(allowed);
      }
    });
    it("allows every 2a key and every 2b key", () => {
      expect(DERIVED_FACT_ATTR_KEYS).toEqual(
        expect.arrayContaining([
          "source_event_id",
          "fact_id",
          "fact_type",
          "confidence",
          "tier",
          "extractor",
          "extractor_version",
          "span",
          "when",
          "who",
          "direction",
          "conversation_key",
          "ics_uid",
          "links",
          "model",
          "review_reason"
        ])
      );
      expect(fact({ confidence: 0.5, tier: "t1" })).toBeNull();
    });
  });

  describe("times and shapes", () => {
    it("rejects hour 24, year 0000, a fraction over 9 digits and an end before the start", () => {
      const at = (start: string, end?: string) =>
        fact({ when: { ...WHEN, candidates: [{ start, ...(end ? { end } : {}) }] } });
      expect(at("2026-11-13T24:00:00Z")).toContain("candidates[0].start");
      expect(at("0000-11-13T10:00:00Z")).toContain("candidates[0].start");
      expect(at("2026-11-13T10:00:00.1234567890Z")).toContain("candidates[0].start");
      expect(at("2026-11-13T10:00:00.123456789Z")).toBeNull();
      expect(at("2026-11-13T10:60:00Z")).toContain("candidates[0].start");
      expect(at("2026-11-13T10:00:00+24:00")).toContain("candidates[0].start");
      const reversed = at("2026-11-13T10:00:00Z", "2026-11-13T09:00:00Z");
      expect(reversed).toContain("end");
      expect(reversed).toContain("before");
      expect(at("2026-11-13T10:00:00Z", "2026-11-13T10:00:00Z")).toBeNull();
      expect(fact({ when: { ...WHEN, ref_time: "2026-11-08T24:00:00Z" } })).toContain("ref_time");
    });
    it("takes only supported zones, and UTC", () => {
      expect(fact({ when: { ...WHEN, tz: "UTC" } })).toBeNull();
      expect(fact({ when: { ...WHEN, tz: "Australia/Sydney" } })).toBeNull();
      expect(fact({ when: { ...WHEN, tz: "+11:00" } })).toContain("IANA");
      expect(fact({ when: { ...WHEN, tz: "sydney" } })).toContain("IANA");
    });
    it("bounds when.raw and span offsets to the content cap", () => {
      expect(fact({ when: { ...WHEN, raw: [5, DERIVED_CONTENT_MAX_CODE_POINTS] } })).toBeNull();
      const raw = fact({ when: { ...WHEN, raw: [5, DERIVED_CONTENT_MAX_CODE_POINTS + 1] } });
      expect(raw).toContain(String(DERIVED_CONTENT_MAX_CODE_POINTS));
      const span = fact({
        span: { ...SPAN, start: DERIVED_CONTENT_MAX_CODE_POINTS, end: DERIVED_CONTENT_MAX_CODE_POINTS + 5 }
      });
      expect(span).toContain(String(DERIVED_CONTENT_MAX_CODE_POINTS));
    });
    it("refuses who entries that differ only in case, and ones with line separators or only invisible characters", () => {
      expect(fact({ direction: "out", who: ["Bob@Example.test", "bob@example.TEST"] })).toContain("more than once");
      expect(fact({ direction: "in", who: ["a@example.test\u2028b"] })).toContain("attrs.who[0]");
      expect(fact({ direction: "in", who: ["a@example.test\u2029"] })).toContain("attrs.who[0]");
      expect(fact({ direction: "in", who: ["\u200b\u200b"] })).toContain("attrs.who[0]");
      expect(fact({ direction: "in", who: ["\ufeff "] })).toContain("attrs.who[0]");
    });
  });

  it("applies the same rules to derived-shadow rows through validateActivityEvent", () => {
    const row = (attrs: Record<string, unknown>) =>
      validateActivityEvent(
        {
          id: "k1",
          source: "derived-shadow",
          kind: "fact",
          start: "2026-11-08T00:00:00Z",
          attrs: { ...EXT, source_event_id: "g1", fact_id: FACT_ID, fact_type: "ask", ...attrs }
        },
        NOW
      );
    expect(row({ direction: "in", who: ["a@example.test"] }).ok).toBe(true);
    expect(row({ review_reason: "expired" }).ok).toBe(false);
  });
});

describe("the message label fields fact_types and sensitive", () => {
  const label = (field: string, answer: unknown) =>
    describeDerivedProblem("label", { source_event_id: "g1", field, answer }, null);

  it("takes fact_types as a set of fact types, [] meaning none", () => {
    expect(label("fact_types", [])).toBeNull();
    expect(label("fact_types", ["ask", "deadline"])).toBeNull();
  });
  it("refuses null for fact_types, saying [] is the answer for none", () => {
    const problem = label("fact_types", null);
    expect(problem).toContain("[]");
    expect(problem).toContain("none");
  });
  it("rejects a non-list, a repeat and an unknown type, naming the types", () => {
    expect(label("fact_types", "ask")).toContain("list");
    expect(label("fact_types", ["ask", "ask"])).toContain("more than once");
    const problem = label("fact_types", ["ask", "invite"]);
    expect(problem).toContain('"invite"');
    for (const type of DERIVED_FACT_TYPES) expect(problem).toContain(type);
  });
  it("takes sensitive as true or false only", () => {
    expect(label("sensitive", true)).toBeNull();
    expect(label("sensitive", false)).toBeNull();
    expect(label("sensitive", null)).toContain("true or false");
    expect(label("sensitive", "yes")).toContain("true or false");
  });
  it("does not offer these fields for a labelled fact, and leaves other answers alone", () => {
    const problem = describeDerivedProblem("label", { fact_id: FACT_ID, field: "sensitive", answer: true }, null);
    expect(problem).toContain('"sensitive"');
    expect(label("class", "bulk")).toBeNull();
  });
});
