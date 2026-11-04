import { describe, expect, it } from "vitest";
import { commitmentProtection, effectiveCommitmentEnd, type FixedCommitment } from "../../src/index.js";
import { commitmentTimeline } from "../../src/model/commitment-timeline.js";

/**
 * A shift tracked 38 minutes past its scheduled `endsAt` left both the protected
 * window and the after-routine chain computed against the stale scheduled end, so the after-routine
 * steps' window had already elapsed and the commitment read as long since unprotected while the
 * person was still there. `trackedEndedAt` — the actual end of a tracked session, from the wire
 * contract or a still-open live session (`engine.ts`'s `resolveTrackedEndedAt`) — is the fix's one
 * new fact; `effectiveCommitmentEnd` and `commitmentProtection` are the two places it changes what
 * the engine reports.
 */

const commitment = (overrides: Partial<FixedCommitment> = {}): FixedCommitment => ({
  id: "work",
  startsAt: new Date("2027-09-04T20:00:00.000Z"),
  endsAt: new Date("2027-09-04T23:00:00.000Z"),
  setupBeforeMinutes: 10,
  transitionAfterMinutes: 20,
  ...overrides
});

describe("effectiveCommitmentEnd", () => {
  it("is the scheduled endsAt when no overtime is tracked at all", () => {
    expect(effectiveCommitmentEnd(commitment())).toEqual(new Date("2027-09-04T23:00:00.000Z"));
  });

  it("is the scheduled endsAt when the tracked end is at or before it (finished on time or early)", () => {
    expect(effectiveCommitmentEnd(commitment({ trackedEndedAt: new Date("2027-09-04T23:00:00.000Z") }))).toEqual(
      new Date("2027-09-04T23:00:00.000Z")
    );
    expect(effectiveCommitmentEnd(commitment({ trackedEndedAt: new Date("2027-09-04T22:50:00.000Z") }))).toEqual(
      new Date("2027-09-04T23:00:00.000Z")
    );
  });

  it("is the tracked end when it ran later than the scheduled endsAt", () => {
    const trackedEndedAt = new Date("2027-09-04T23:31:12.000Z");
    expect(effectiveCommitmentEnd(commitment({ trackedEndedAt }))).toEqual(trackedEndedAt);
  });
});

describe("commitmentProtection with tracked overtime", () => {
  it("extends the protected window's after-edge from the tracked end, not the stale scheduled endsAt", () => {
    const trackedEndedAt = new Date("2027-09-04T23:31:12.000Z"); // 31 minutes of overtime.
    const protection = commitmentProtection(commitment({ trackedEndedAt }), 2);
    // Before this fix, endsAt(23:00) + transitionAfterMinutes(20) = 23:20 — already elapsed by the
    // time the person actually clocked out at 23:31:12.
    expect(protection.endsAt).toEqual(new Date("2027-09-04T23:51:12.000Z"));
  });

  it("reproduces the pre-existing window exactly when there is no tracked overtime", () => {
    const protection = commitmentProtection(commitment(), 2);
    expect(protection.endsAt).toEqual(new Date("2027-09-04T23:20:00.000Z"));
  });

  it("keeps a still-open overtime session protected: the after-edge stays ahead of the live instant", () => {
    // Mirrors `engine.ts`'s `resolveTrackedEndedAt`, which sets `trackedEndedAt` to the live instant
    // itself while a session against the commitment is still open past its scheduled end.
    const liveNow = new Date("2027-09-04T23:30:00.000Z");
    const protection = commitmentProtection(commitment({ trackedEndedAt: liveNow }), 2);
    expect(protection.endsAt.getTime()).toBeGreaterThan(liveNow.getTime());
    expect(protection.endsAt).toEqual(new Date("2027-09-04T23:50:00.000Z"));
  });

  it("never moves the before-edge — tracked overtime is purely an after-the-fact signal", () => {
    const trackedEndedAt = new Date("2027-09-04T23:31:12.000Z");
    const withOvertime = commitmentProtection(commitment({ trackedEndedAt }), 2);
    const without = commitmentProtection(commitment(), 2);
    expect(withOvertime.startsAt).toEqual(without.startsAt);
  });
});

describe("commitmentProtection equals the timeline's [setupStartsAt, protectedUntil]", () => {
  const setupValues = [0, 10];
  const transitionValues = [0, 20];
  const travelBeforeValues = [0, 15, 30];
  const travelAfterValues = [0, 15, 25];
  const overtimeOffsetsMinutes = [0, -5, 31];
  const margin = 2;

  it("holds over a grid of setup/transition/travel/overtime combinations", () => {
    let cases = 0;
    for (const setupBeforeMinutes of setupValues) {
      for (const transitionAfterMinutes of transitionValues) {
        for (const travelBeforeMinutes of travelBeforeValues) {
          for (const travelAfterMinutes of travelAfterValues) {
            for (const overtimeOffset of overtimeOffsetsMinutes) {
              const trackedEndedAt = new Date(commitment().endsAt.getTime() + overtimeOffset * 60_000);
              const candidate = commitment({
                setupBeforeMinutes,
                transitionAfterMinutes,
                travelBeforeMinutes,
                travelAfterMinutes,
                trackedEndedAt
              });

              const protection = commitmentProtection(candidate, margin);
              const timeline = commitmentTimeline(candidate, margin);

              expect(protection.startsAt).toEqual(timeline.setupStartsAt);
              expect(protection.endsAt).toEqual(timeline.protectedUntil);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(
      setupValues.length *
        transitionValues.length *
        travelBeforeValues.length *
        travelAfterValues.length *
        overtimeOffsetsMinutes.length
    );
  });
});
