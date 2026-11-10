import { describe, expect, it } from "vitest";
import { checkInCommandSchema, CHECK_IN_NOTE_MAX_CHARS } from "./commands.js";

const id = "e9f6ac30-f59f-4852-a65b-d3074da3b090";
const base = { commandId: "11111111-1111-4111-8111-111111111111", expectedVersion: null };
const answer = (extra: Record<string, unknown>) =>
  checkInCommandSchema.safeParse({ ...base, type: "answer_check_in", checkInId: id, answerSource: "sheet", ...extra });

describe("words-first check-in answers", () => {
  it.each(["on_track", "deviated", "unknown"])("takes his words on a %s answer", (status) => {
    expect(answer({ status, deviationNote: "slower than planned" }).success).toBe(true);
  });

  it("raises the note cap to 8000 characters and refuses more", () => {
    expect(CHECK_IN_NOTE_MAX_CHARS).toBe(8000);
    expect(answer({ status: "on_track", deviationNote: "x".repeat(8000) }).success).toBe(true);
    expect(answer({ status: "on_track", deviationNote: "x".repeat(8001) }).success).toBe(false);
  });

  it("applies the same cap to a voluntary check-in and a reconciliation tail", () => {
    const voluntary = (n: number) =>
      checkInCommandSchema.safeParse({
        ...base,
        type: "voluntary_check_in",
        status: "on_track",
        answerSource: "app",
        deviationNote: "x".repeat(n)
      }).success;
    expect(voluntary(8000)).toBe(true);
    expect(voluntary(8001)).toBe(false);
    const tail = (n: number) =>
      checkInCommandSchema.safeParse({
        commandId: base.commandId,
        type: "answer_check_ins",
        checkInIds: [id],
        upTo: "2026-11-10T09:00:00+11:00",
        tail: { status: "unknown", deviationNote: "x".repeat(n) }
      }).success;
    expect(tail(8000)).toBe(true);
    expect(tail(8001)).toBe(false);
  });

  it("still accepts a category on a deviated answer for old clients, and still refuses it elsewhere", () => {
    expect(answer({ status: "deviated", deviationCategory: "work" }).success).toBe(true);
    expect(answer({ status: "on_track", deviationCategory: "work" }).success).toBe(false);
  });

  it.each(["in_app_banner", "sheet", "push_action", "widget", "shortcut", "app", "session_reconciliation"])(
    "accepts answerSource %s on an answer",
    (answerSource) => {
      expect(answer({ status: "on_track", answerSource }).success).toBe(true);
    }
  );

  it("accepts the new sources on a voluntary check-in but not session_reconciliation", () => {
    const voluntary = (answerSource: string) =>
      checkInCommandSchema.safeParse({ ...base, type: "voluntary_check_in", status: "unknown", answerSource }).success;
    for (const source of ["push_action", "widget", "shortcut", "app"]) expect(voluntary(source)).toBe(true);
    expect(voluntary("session_reconciliation")).toBe(false);
    expect(voluntary("telepathy")).toBe(false);
  });
});

describe("tag_check_in", () => {
  const tag = (extra: Record<string, unknown>) =>
    checkInCommandSchema.safeParse({ ...base, type: "tag_check_in", checkInId: id, ...extra });

  it("adds tags with a mark and normalises them", () => {
    const parsed = tag({ add: [{ tag: "  School Run ", mark: "inferred" }] });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === "tag_check_in")
      expect(parsed.data.add).toEqual([{ tag: "school run", mark: "inferred" }]);
  });

  it("removes tags", () => {
    expect(tag({ remove: ["school run"] }).success).toBe(true);
  });

  it("refuses an empty command, a tag in both lists, a bad mark and an over-long tag", () => {
    expect(tag({}).success).toBe(false);
    expect(tag({ add: [], remove: [] }).success).toBe(false);
    expect(tag({ add: [{ tag: "a", mark: "stated" }], remove: ["A"] }).success).toBe(false);
    expect(tag({ add: [{ tag: "a", mark: "guessed" }] }).success).toBe(false);
    expect(tag({ add: [{ tag: "x".repeat(41), mark: "stated" }] }).success).toBe(false);
    expect(tag({ add: [{ tag: "two\nlines", mark: "stated" }] }).success).toBe(false);
  });

  it("carries no status, words or source: it cannot change the answer", () => {
    const parsed = tag({ add: [{ tag: "a", mark: "stated" }], status: "on_track" });
    expect(parsed.success && "status" in parsed.data).toBe(false);
  });
});
