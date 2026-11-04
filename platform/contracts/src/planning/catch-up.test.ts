import { describe, expect, it } from "vitest";
import {
  CATCH_UP_DUE_AFTER_HOURS,
  catchUpDue,
  catchUpNudgeDedupeKey,
  composeCatchUpNudge,
  settleCatchUpCommandSchema
} from "./catch-up.js";

const commandId = "9f1c6f0e-2a37-4a8e-8d52-0e1f4a0c7b11";

describe("settleCatchUpCommandSchema", () => {
  it("reads a missing basis as inferred and defaults closeWindow off", () => {
    const parsed = settleCatchUpCommandSchema.parse({
      commandId,
      verdicts: [{ entryId: "occurrence:o1", verdict: "skipped" }]
    });
    expect(parsed).toMatchObject({ basis: "inferred", closeWindow: false });
  });

  it("requires the person's words as evidence for a stated settle", () => {
    const stated = { commandId, basis: "stated", verdicts: [{ entryId: "occurrence:o1", verdict: "done" }] };
    expect(settleCatchUpCommandSchema.safeParse(stated).success).toBe(false);
    expect(settleCatchUpCommandSchema.safeParse({ ...stated, evidence: "I did the stretches Tuesday" }).success).toBe(
      true
    );
  });

  it("needs a project for all_dropped but not for all_skipped", () => {
    expect(settleCatchUpCommandSchema.safeParse({ commandId, verdicts: [{ bulk: "all_dropped" }] }).success).toBe(
      false
    );
    expect(
      settleCatchUpCommandSchema.safeParse({ commandId, verdicts: [{ bulk: "all_dropped", projectId: "p1" }] }).success
    ).toBe(true);
    expect(settleCatchUpCommandSchema.safeParse({ commandId, verdicts: [{ bulk: "all_skipped" }] }).success).toBe(true);
  });

  it("takes skip_older_than over the whole window only, refusing a day or project scope", () => {
    const ok = settleCatchUpCommandSchema.safeParse({ commandId, verdicts: [{ bulk: "skip_older_than", days: 7 }] });
    expect(ok.success).toBe(true);
    for (const scope of [{ projectId: "p1" }, { day: "2026-09-02" }]) {
      const scoped = settleCatchUpCommandSchema.safeParse({
        commandId,
        verdicts: [{ bulk: "skip_older_than", days: 7, ...scope }]
      });
      expect(scoped.success, JSON.stringify(scope)).toBe(false);
    }
  });

  it("rejects an empty or oversized batch and a bad verdict name", () => {
    expect(settleCatchUpCommandSchema.safeParse({ commandId, verdicts: [] }).success).toBe(false);
    expect(
      settleCatchUpCommandSchema.safeParse({ commandId, verdicts: [{ entryId: "occurrence:o1", verdict: "maybe" }] })
        .success
    ).toBe(false);
  });
});

describe("catch-up nudge", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);

  it("is due only past the threshold with something unsettled", () => {
    expect(catchUpDue(hoursAgo(CATCH_UP_DUE_AFTER_HOURS), 1, now)).toBe(true);
    expect(catchUpDue(hoursAgo(CATCH_UP_DUE_AFTER_HOURS - 1), 1, now)).toBe(false);
    expect(catchUpDue(hoursAgo(100), 0, now)).toBe(false);
    expect(catchUpDue(null, 3, now)).toBe(true);
  });

  it("keys the push by the window start, so a new absence sends again", () => {
    const first = catchUpNudgeDedupeKey(new Date("2026-10-05T08:00:00.000Z"));
    expect(first).toBe("catch-up-due:2026-10-05T08:00:00.000Z");
    expect(catchUpNudgeDedupeKey(new Date("2026-10-08T08:00:00.000Z"))).not.toBe(first);
  });

  it("words the push with whole days and the right plural", () => {
    expect(composeCatchUpNudge(hoursAgo(24 * 5 + 3), 5, now)).toEqual({
      title: "Your plan is waiting",
      body: "You've been away 5 days. 5 things to settle."
    });
    expect(composeCatchUpNudge(hoursAgo(37), 1, now).body).toBe("You've been away 1 day. 1 thing to settle.");
  });
});
