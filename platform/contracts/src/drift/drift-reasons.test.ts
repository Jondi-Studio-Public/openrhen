import { describe, expect, it } from "vitest";
import {
  REASON_TAGS_MAX,
  REASON_TAG_MAX_CHARS,
  REASON_TEXT_MAX_BYTES,
  REASON_TEXT_MAX_CHARS,
  correctedReasonTagKey,
  describeReasonTagsProblem,
  describeReasonTextProblem,
  inferredReasonTagKey,
  normaliseReasonTag,
  normaliseReasonText,
  reasonKey,
  resolveReasons,
  type ReasonRow
} from "./drift-reasons.js";

const CHECK_IN = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

describe("reason text", () => {
  it("takes plain words and trims only the outer whitespace", () => {
    expect(normaliseReasonText("  a loud\n  neighbour \n")).toBe("a loud\n  neighbour");
    expect(describeReasonTextProblem("a loud neighbour\nand a tap")).toBeNull();
  });

  it("refuses empty text, with a readable sentence", () => {
    expect(describeReasonTextProblem("")).toMatch(/empty/);
    expect(describeReasonTextProblem(42)).toMatch(/text/);
  });

  it("caps characters, then UTF-8 bytes, so a full box of emoji is refused with the limit named", () => {
    expect(describeReasonTextProblem("x".repeat(REASON_TEXT_MAX_CHARS))).toBeNull();
    expect(describeReasonTextProblem("x".repeat(REASON_TEXT_MAX_CHARS + 1))).toMatch(/limit is 1000/);
    // 1000 four-byte characters are inside the character limit and far over the byte limit.
    const emoji = "\u{1F600}".repeat(1000);
    const problem = describeReasonTextProblem(emoji);
    expect(problem).toContain(String(REASON_TEXT_MAX_BYTES));
    expect(problem).toMatch(/bytes/);
    expect(describeReasonTextProblem("\u{1F600}".repeat(Math.floor(REASON_TEXT_MAX_BYTES / 4)))).toBeNull();
  });

  it("refuses control characters other than a line break and a tab, and never repeats the words", () => {
    expect(describeReasonTextProblem("a\u0000b")).toMatch(/control/);
    expect(describeReasonTextProblem("a\tb\nc")).toBeNull();
    const secret = "my sister's surprise party " + "x".repeat(REASON_TEXT_MAX_CHARS);
    expect(describeReasonTextProblem(secret)).not.toContain("sister");
  });
});

describe("tags", () => {
  it("normalises to composed, trimmed, lower case", () => {
    expect(normaliseReasonTag("  Burnt Out ")).toBe("burnt out");
    expect(normaliseReasonTag("Café")).toBe("café");
  });

  it("accepts an empty list and up to six short, normalised, distinct phrases", () => {
    expect(describeReasonTagsProblem([])).toBeNull();
    expect(describeReasonTagsProblem(["tired", "noise"])).toBeNull();
    expect(describeReasonTagsProblem(Array.from({ length: REASON_TAGS_MAX }, (_, n) => `tag ${n}`))).toBeNull();
  });

  it("refuses too many, too long, empty, unnormalised, repeated and multi-line tags without echoing them", () => {
    expect(describeReasonTagsProblem(Array.from({ length: REASON_TAGS_MAX + 1 }, (_, n) => `t${n}`))).toBe(
      "A reason can have at most 6 tags; this has 7."
    );
    expect(describeReasonTagsProblem(["x".repeat(REASON_TAG_MAX_CHARS + 1)])).toMatch(/1 to 40/);
    expect(describeReasonTagsProblem([""])).toMatch(/1 to 40/);
    expect(describeReasonTagsProblem(["Tired"])).toMatch(/lower case/);
    expect(describeReasonTagsProblem([" tired"])).toMatch(/trimmed/);
    expect(describeReasonTagsProblem(["tired", "tired"])).toMatch(/twice/);
    expect(describeReasonTagsProblem(["a\nb"])).toMatch(/control/);
    expect(describeReasonTagsProblem([3])).toMatch(/text/);
    expect(describeReasonTagsProblem("tired")).toMatch(/list/);
    expect(describeReasonTagsProblem(["Zebra stripes"])).not.toContain("Zebra");
  });
});

describe("keys", () => {
  it("name the check-in and the request, with no characters that need escaping in an address", () => {
    expect(reasonKey(CHECK_IN, "req-12345678")).toBe(`reason|${CHECK_IN}|req-12345678`);
    expect(correctedReasonTagKey(CHECK_IN, "req-12345678")).toBe(`reason_tag|${CHECK_IN}|corrected|req-12345678`);
    expect(inferredReasonTagKey(CHECK_IN, 2, "local-model")).toBe(`reason_tag|${CHECK_IN}|inferred|v2|local-model`);
  });
});

describe("resolveReasons", () => {
  const row = (id: string, checkInId: string, text: string, at: string, via: string | null = null): ReasonRow => ({
    id,
    checkInId,
    text,
    ingestedAt: new Date(at),
    ingestedVia: via
  });

  it("keeps the latest save for each check-in, by time stored then id", () => {
    const rows = [
      row("b", CHECK_IN, "first", "2026-11-09T10:00:00Z"),
      row("a", CHECK_IN, "second", "2026-11-09T10:05:00Z"),
      row("c", OTHER, "other", "2026-11-09T09:00:00Z")
    ];
    const resolved = resolveReasons(rows);
    expect(resolved.get(CHECK_IN)?.text).toBe("second");
    expect(resolved.get(OTHER)?.text).toBe("other");
    expect(resolveReasons([...rows].reverse()).get(CHECK_IN)?.text).toBe("second");
  });

  it("breaks a tie in the stored time on the row id, the same way whatever the order", () => {
    const tie = [row("a", CHECK_IN, "low", "2026-11-09T10:00:00Z"), row("b", CHECK_IN, "high", "2026-11-09T10:00:00Z")];
    expect(resolveReasons(tie).get(CHECK_IN)?.text).toBe("high");
    expect(resolveReasons([...tie].reverse()).get(CHECK_IN)?.text).toBe("high");
  });

  it("ignores a row that is not the owner's", () => {
    const rows = [
      row("a", CHECK_IN, "mine", "2026-11-09T10:00:00Z"),
      row("b", CHECK_IN, "forged", "2026-11-09T11:00:00Z", "someone")
    ];
    expect(resolveReasons(rows).get(CHECK_IN)?.text).toBe("mine");
    expect(resolveReasons([rows[1]!]).size).toBe(0);
  });
});
