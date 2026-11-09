import { describe, expect, it } from "vitest";
import {
  matchDeadline,
  MOVED_WINDOW_DAYS,
  RESCHEDULE_CUE,
  type DeadlineProbe,
  type DeadlineTarget
} from "./deadline-match.js";

const target = (overrides: Partial<DeadlineTarget> = {}): DeadlineTarget => ({
  id: "a1",
  title: "Quarterly report",
  dueOn: "2026-11-20",
  ...overrides
});
const probe = (overrides: Partial<DeadlineProbe> = {}): DeadlineProbe => ({
  kind: "deadline",
  title: "Quarterly report due",
  dueOn: "2026-11-20",
  ...overrides
});

describe("matchDeadline", () => {
  it("is strong for a reworded title on the same date", () => {
    expect(matchDeadline(probe({ title: "Reminder: quarterly report due" }), [target()])).toMatchObject({
      kind: "strong",
      targetId: "a1"
    });
  });

  it("reads the same title on a later or earlier date as the same deadline, moved", () => {
    expect(matchDeadline(probe({ dueOn: "2026-11-23" }), [target()])).toMatchObject({
      kind: "strong",
      targetId: "a1",
      moved: { from: "2026-11-20", to: "2026-11-23" }
    });
    expect(matchDeadline(probe({ dueOn: "2026-11-10" }), [target()]).moved).toEqual({
      from: "2026-11-20",
      to: "2026-11-10"
    });
  });

  it("asks when the same unnumbered title is a whole number of weeks away and nothing says it moved", () => {
    for (const dueOn of ["2026-11-27", "2026-12-04", "2026-11-13"]) {
      const result = matchDeadline(probe({ dueOn }), [target()]);
      expect(result, dueOn).toMatchObject({ kind: "possible", targetId: "a1" });
      expect(result.moved?.to).toBe(dueOn);
    }
  });

  it("still reads a weekly gap as a move when the message says so", () => {
    expect(matchDeadline(probe({ dueOn: "2026-11-27", rescheduled: true }), [target()])).toMatchObject({
      kind: "strong",
      moved: { from: "2026-11-20", to: "2026-11-27" }
    });
  });

  it("keeps other gaps as moves without a cue, and numbered titles as the same instance", () => {
    expect(matchDeadline(probe({ dueOn: "2026-11-23" }), [target()])).toMatchObject({ kind: "strong" });
    expect(matchDeadline(probe({ dueOn: "2026-11-30" }), [target()]).kind).toBe("strong");
    expect(matchDeadline(probe({ title: "Quiz 3 due", dueOn: "2026-11-27" }), [target({ title: "Quiz 3" })]).kind).toBe(
      "strong"
    );
  });

  it("recognises the reschedule cue words", () => {
    for (const text of ["Report due moved", "rescheduled to Friday", "Deadline postponed", "extended by a week"]) {
      expect(RESCHEDULE_CUE.test(text), text).toBe(true);
    }
    expect(RESCHEDULE_CUE.test("Report due")).toBe(false);
  });

  it("holds the window at fourteen days: a fortnight is moved, fifteen is only possible", () => {
    expect(MOVED_WINDOW_DAYS).toBe(14);
    expect(matchDeadline(probe({ dueOn: "2026-12-04", rescheduled: true }), [target()])).toMatchObject({
      kind: "strong"
    });
    const far = matchDeadline(probe({ dueOn: "2026-12-05" }), [target()]);
    expect(far).toMatchObject({ kind: "possible", targetId: "a1", moved: { from: "2026-11-20", to: "2026-12-05" } });
  });

  it("is possible for a similar title on the same date, and none for an unrelated one", () => {
    expect(
      matchDeadline(probe({ title: "Quarterly figures sheet" }), [target({ title: "Quarterly report figures draft" })])
        .kind
    ).toBe("possible");
    expect(matchDeadline(probe({ title: "Dentist visit" }), [target()]).kind).toBe("none");
  });

  it("reaches possible only for an undated ask", () => {
    const ask = probe({ kind: "ask", title: "Send the signed form", dueOn: null });
    expect(matchDeadline(ask, [target({ title: "Send the signed form", dueOn: null })])).toMatchObject({
      kind: "possible"
    });
    expect(matchDeadline(ask, [target({ title: "Send the signed form" })]).kind).toBe("possible");
    expect(matchDeadline(ask, [target({ title: "Book the room", dueOn: null })]).kind).toBe("none");
  });

  it("keeps numbered siblings apart, even where one title contains the other", () => {
    const siblings = [target({ id: "a1", title: "Assignment 1" }), target({ id: "a2", title: "Assignment 12" })];
    expect(matchDeadline(probe({ title: "Assignment 12" }), siblings)).toMatchObject({
      kind: "strong",
      targetId: "a2"
    });
    expect(matchDeadline(probe({ title: "Assignment 2" }), siblings).kind).toBe("none");
    // A number on one side only, or an extra number such as a date, is not a conflict.
    expect(matchDeadline(probe({ title: "Quiz 3 due 15" }), [target({ title: "Quiz 3" })]).kind).toBe("strong");
    expect(matchDeadline(probe({ title: "Quiz 3" }), [target({ title: "Quiz 3 due 15" })]).kind).toBe("strong");
    expect(matchDeadline(probe({ title: "Quiz 3 due 15" }), [target({ title: "Quiz 4" })]).kind).toBe("none");
    expect(matchDeadline(probe({ title: "Quiz 3 due 15" }), [target({ title: "Quiz 4 due 15" })]).kind).toBe("none");
    expect(matchDeadline(probe({ title: "Assignment" }), [target({ title: "Assignment 1" })]).kind).toBe("strong");
  });

  it("is exact for a unit code that exactly one target names, even on another date", () => {
    const targets = [
      target({ id: "a1", title: "ABC10001 essay", unitCodes: ["ABC10001"] }),
      target({ id: "a2", title: "ABC10002 essay", unitCodes: ["ABC10002"] })
    ];
    expect(
      matchDeadline(probe({ title: "ABC10002 work", dueOn: "2027-01-30", unitCodes: ["ABC10002"] }), targets)
    ).toMatchObject({
      kind: "exact",
      targetId: "a2",
      moved: { from: "2026-11-20", to: "2027-01-30" }
    });
  });

  it("does not let a unit code several targets name decide anything", () => {
    const targets = [
      target({ id: "a1", title: "ABC10001 essay", unitCodes: ["ABC10001"] }),
      target({ id: "a2", title: "ABC10001 quiz", dueOn: "2026-12-30", unitCodes: ["ABC10001"] })
    ];
    const result = matchDeadline(probe({ title: "Essay due", unitCodes: ["ABC10001"] }), targets);
    expect(result.kind).not.toBe("exact");
  });

  it("never matches a closed target", () => {
    expect(matchDeadline(probe(), [target({ open: false })]).kind).toBe("none");
  });

  it("returns a tie for two equal best matches, the same in any order", () => {
    const twins = [target({ id: "b" }), target({ id: "a" })];
    const forward = matchDeadline(probe(), twins);
    expect(forward).toMatchObject({ kind: "strong", tie: true, targetId: "a", candidates: ["a", "b"] });
    expect(matchDeadline(probe(), [...twins].reverse())).toEqual(forward);
    expect(forward.moved).toBeUndefined();
  });

  it("returns a tie between two open asks, earliest due first and undated last", () => {
    const ask = probe({ kind: "ask", title: "Send the signed form", dueOn: null });
    const asks = [
      target({ id: "z", title: "Send signed form", dueOn: null }),
      target({ id: "y", title: "Send the signed form", dueOn: "2026-11-02" })
    ];
    expect(matchDeadline(ask, asks)).toMatchObject({ kind: "possible", tie: true, candidates: ["y", "z"] });
  });

  it("is not a tie when one match outranks the other", () => {
    const result = matchDeadline(probe(), [target({ id: "far", dueOn: "2026-12-30" }), target({ id: "same" })]);
    expect(result).toMatchObject({ kind: "strong", targetId: "same" });
    expect(result.tie).toBeUndefined();
  });

  it("matches non-ASCII titles by their letters, which is as far as it goes", () => {
    expect(matchDeadline(probe({ title: "Отчёт за квартал" }), [target({ title: "Отчёт за квартал" })]).kind).toBe(
      "strong"
    );
    expect(matchDeadline(probe({ title: "季度报告" }), [target({ title: "Quarterly report" })]).kind).toBe("none");
  });
});
