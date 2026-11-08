import { describe, expect, it } from "vitest";
import {
  ACTIVITY_DERIVED_ATTRS_MAX_BYTES,
  DERIVED_FACT_STATUSES,
  DERIVED_FACT_TYPES,
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
    expect(describeDerivedProblem("label", { fact_id: FACT_ID, answer: "ask" }, null)).toBeNull();
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
