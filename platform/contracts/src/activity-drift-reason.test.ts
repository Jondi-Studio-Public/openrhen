import { describe, expect, it } from "vitest";
import { ACTIVITY_OWNER_ONLY_SOURCES, activityKindsOf, validateActivityEvent } from "./activity-events.js";
import {
  REASON_TEXT_MAX_BYTES,
  correctedReasonTagKey,
  inferredReasonTagKey,
  reasonKey
} from "./drift/drift-reasons.js";

const NOW = new Date("2026-11-09T12:00:00Z");
const CHECK_IN = "11111111-1111-4111-8111-111111111111";
const REQUEST = "req-12345678";

const reason = (over: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) => ({
  id: reasonKey(CHECK_IN, REQUEST),
  source: "drift-reason",
  kind: "reason",
  start: "2026-11-09T11:00:00Z",
  attrs: { check_in_id: CHECK_IN, text: "a loud neighbour", request_id: REQUEST, ...attrs },
  ...over
});
const corrected = (attrs: Record<string, unknown>, id = correctedReasonTagKey(CHECK_IN, REQUEST)) => ({
  id,
  source: "drift-reason",
  kind: "reason_tag",
  start: "2026-11-09T11:00:00Z",
  attrs: { check_in_id: CHECK_IN, origin: "corrected", request_id: REQUEST, ...attrs }
});
const inferred = (attrs: Record<string, unknown> = {}, id = inferredReasonTagKey(CHECK_IN, 1, "local-model")) => ({
  id,
  source: "drift-reason",
  kind: "reason_tag",
  start: "2026-11-09T11:00:00Z",
  attrs: {
    check_in_id: CHECK_IN,
    origin: "inferred",
    tags: ["noise"],
    model: { id: "local-model" },
    prompt_version: 1,
    ...attrs
  }
});
const problem = (event: Record<string, unknown>) => {
  const verdict = validateActivityEvent(event, NOW);
  return verdict.ok ? null : verdict.reason;
};

describe("source drift-reason", () => {
  it("is registered with kinds reason and reason_tag, no class, and listed as owner-only", () => {
    expect(activityKindsOf("drift-reason")).toEqual(["reason", "reason_tag"]);
    expect(ACTIVITY_OWNER_ONLY_SOURCES).toEqual(["drift-reason"]);
  });

  it("takes a reason with its words in attrs.text", () => {
    expect(problem(reason())).toBeNull();
  });

  it("refuses the generic correction kind, content, an end time and attrs.by", () => {
    expect(problem(reason({ kind: "correction" }))).toMatch(/correction/);
    expect(problem(reason({ content: "words" }))).toMatch(/content/);
    expect(problem(reason({ end: "2026-11-09T11:30:00Z" }))).toMatch(/instant/);
    expect(problem(reason({}, { by: "x" }))).toMatch(/attrs\.by/);
  });

  it("refuses an unknown attr, a bad check-in or request id, and an id that is not the key", () => {
    expect(problem(reason({}, { mood: "x" }))).toMatch(/not allowed/);
    expect(problem(reason({}, { check_in_id: "nope" }))).toMatch(/check_in_id/);
    expect(problem(reason({}, { request_id: "short" }))).toMatch(/request_id/);
    expect(problem(reason({ id: "reason|wrong" }))).toMatch(/event id must be/);
  });

  it("caps the text in bytes with a readable sentence that does not repeat the words", () => {
    const words = "\u{1F600}".repeat(1000);
    const found = problem(reason({}, { text: words }));
    expect(found).toContain(String(REASON_TEXT_MAX_BYTES));
    expect(found).not.toContain("\u{1F600}");
    expect(problem(reason({}, { text: "" }))).toMatch(/empty/);
    expect(problem(reason({}, { text: " padded " }))).toMatch(/whitespace/);
  });

  it("stores the longest allowed text however much escaping it needs, inside the attrs limit", () => {
    // 1000 characters of the worst case for escaping (a backslash is two bytes in JSON), and a full box of 3-byte characters.
    expect(problem(reason({}, { text: "\\".repeat(1000) }))).toBeNull();
    expect(problem(reason({}, { text: "x" + "\n".repeat(998) + "x" }))).toBeNull();
    expect(problem(reason({}, { text: "\u20AC".repeat(1000) }))).toBeNull();
    expect(problem(reason({}, { text: "\u{1F600}".repeat(875) }))).toBeNull();
  });

  it("takes a corrected tag row, a reset, and an inferred row", () => {
    expect(problem(corrected({ tags: ["tired", "noise"] }))).toBeNull();
    expect(problem(corrected({ tags: [], reset: true }))).toBeNull();
    expect(problem(corrected({ tags: [] }))).toBeNull();
    expect(problem(inferred())).toBeNull();
    expect(problem(inferred({ tags: [] }))).toBeNull();
  });

  it("refuses a reset that carries tags, a malformed tag list, and tags with unknown attrs", () => {
    expect(problem(corrected({ tags: ["tired"], reset: true }))).toMatch(/reset/i);
    expect(problem(corrected({ tags: ["Tired"] }))).toMatch(/lower case/);
    expect(problem(corrected({ tags: ["a", "b", "c", "d", "e", "f", "g"] }))).toBe(
      "A reason can have at most 6 tags; this has 7."
    );
    expect(problem(corrected({ tags: [], reset: false }))).toMatch(/reset/);
    expect(problem(corrected({ tags: [], energy: "low" }))).toMatch(/not allowed/);
    expect(problem(inferred({ input_hash: "x" }))).toMatch(/not allowed/);
  });

  it("checks an inferred row's model, prompt version and key", () => {
    expect(problem(inferred({ model: { id: "bad id!" } }))).toMatch(/model/);
    expect(problem(inferred({ prompt_version: 0 }))).toMatch(/prompt_version/);
    expect(problem(inferred({}, "reason_tag|x"))).toMatch(/event id must be/);
    expect(problem(corrected({ tags: [] }, "reason_tag|x"))).toMatch(/event id must be/);
  });

  it("refuses any other kind", () => {
    expect(problem(reason({ kind: "prompt" }))).toMatch(/not open|kind/);
  });
});
