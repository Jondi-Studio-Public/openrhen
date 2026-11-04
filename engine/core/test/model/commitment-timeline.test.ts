import { describe, expect, it } from "vitest";
import { commitmentTimeline } from "../../src/model/commitment-timeline.js";
import type { CommitmentTravelLeg, FixedCommitment } from "../../src/index.js";

const travelLeg = (minutes: number): CommitmentTravelLeg => ({
  fromLocationId: "home",
  toLocationId: "gym",
  minutes,
  typicalMinutes: minutes,
  sampleCount: 0,
  source: "fallback"
});

const commitment = (overrides: Partial<FixedCommitment> = {}): FixedCommitment => ({
  id: "work",
  startsAt: new Date("2027-09-04T20:00:00.000Z"),
  endsAt: new Date("2027-09-04T23:00:00.000Z"),
  setupBeforeMinutes: 10,
  transitionAfterMinutes: 20,
  ...overrides
});

describe("commitmentTimeline", () => {
  describe("without a journey", () => {
    it("computes every edge from the bare setup/transition buffers", () => {
      const timeline = commitmentTimeline(commitment(), 2);
      expect(timeline.setupStartsAt).toEqual(new Date("2027-09-04T19:50:00.000Z"));
      expect(timeline.leaveBy).toBeUndefined();
      expect(timeline.arriveBy).toEqual(new Date("2027-09-04T20:00:00.000Z"));
      expect(timeline.startsAt).toEqual(new Date("2027-09-04T20:00:00.000Z"));
      expect(timeline.endsAt).toEqual(new Date("2027-09-04T23:00:00.000Z"));
      expect(timeline.effectiveEndsAt).toEqual(new Date("2027-09-04T23:00:00.000Z"));
      expect(timeline.overtime).toBe(false);
      expect(timeline.freeAt).toEqual(new Date("2027-09-04T23:20:00.000Z"));
      expect(timeline.homeAt).toBeUndefined();
      expect(timeline.protectedUntil).toEqual(new Date("2027-09-04T23:20:00.000Z"));
      expect(timeline.travelBefore).toBeUndefined();
      expect(timeline.travelAfter).toBeUndefined();
    });

    it("treats missing buffers as 0", () => {
      const bare: FixedCommitment = {
        id: "work",
        startsAt: new Date("2027-09-04T20:00:00.000Z"),
        endsAt: new Date("2027-09-04T23:00:00.000Z")
      };
      const timeline = commitmentTimeline(bare, 2);
      expect(timeline.setupStartsAt).toEqual(timeline.startsAt);
      expect(timeline.freeAt).toEqual(timeline.effectiveEndsAt);
    });
  });

  describe("with a journey", () => {
    it("computes leaveBy and arriveBy from the arrival margin and travel minutes", () => {
      const timeline = commitmentTimeline(commitment({ travelBeforeMinutes: 30, travelBefore: travelLeg(30) }), 2);
      expect(timeline.arriveBy).toEqual(new Date("2027-09-04T19:58:00.000Z"));
      expect(timeline.leaveBy).toEqual(new Date("2027-09-04T19:28:00.000Z"));
      expect(timeline.setupStartsAt).toEqual(new Date("2027-09-04T19:18:00.000Z"));
      expect(timeline.travelBefore).toEqual(travelLeg(30));
    });

    it("a journey requires travelBeforeMinutes > 0, not merely the leg object being present", () => {
      const timeline = commitmentTimeline(commitment({ travelBeforeMinutes: 0, travelBefore: travelLeg(0) }), 2);
      expect(timeline.leaveBy).toBeUndefined();
      expect(timeline.arriveBy).toEqual(timeline.startsAt);
      expect(timeline.travelBefore).toBeUndefined();
    });
  });

  describe("with an assumed journey", () => {
    it("computes leaveBy from the assumed minutes and flags the travel time as unknown", () => {
      const timeline = commitmentTimeline(commitment({ travelBeforeMinutes: 30, travelBeforeUnknown: true }), 2);
      expect(timeline.leaveBy).toEqual(new Date("2027-09-04T19:28:00.000Z"));
      expect(timeline.travelUnknown).toBe(true);
    });

    it("does not flag a known journey, or an unknown one that carries no minutes", () => {
      expect(
        commitmentTimeline(commitment({ travelBeforeMinutes: 30, travelBefore: travelLeg(30) }), 2).travelUnknown
      ).toBe(false);
      expect(commitmentTimeline(commitment({ travelBeforeUnknown: true }), 2).travelUnknown).toBe(false);
    });
  });

  describe("with a return leg", () => {
    it("computes homeAt from freeAt plus travelAfterMinutes", () => {
      const timeline = commitmentTimeline(commitment({ travelAfterMinutes: 25, travelAfter: travelLeg(25) }), 2);
      expect(timeline.freeAt).toEqual(new Date("2027-09-04T23:20:00.000Z"));
      expect(timeline.homeAt).toEqual(new Date("2027-09-04T23:45:00.000Z"));
      expect(timeline.protectedUntil).toEqual(timeline.homeAt);
      expect(timeline.travelAfter).toEqual(travelLeg(25));
    });

    it("a homeward leg requires travelAfterMinutes > 0, not merely the leg object being present", () => {
      const timeline = commitmentTimeline(commitment({ travelAfterMinutes: 0, travelAfter: travelLeg(0) }), 2);
      expect(timeline.homeAt).toBeUndefined();
      expect(timeline.protectedUntil).toEqual(timeline.freeAt);
      expect(timeline.travelAfter).toBeUndefined();
    });
  });

  describe("with overtime", () => {
    it("stretches effectiveEndsAt, freeAt and protectedUntil from the tracked end", () => {
      const trackedEndedAt = new Date("2027-09-04T23:31:12.000Z");
      const timeline = commitmentTimeline(commitment({ trackedEndedAt }), 2);
      expect(timeline.effectiveEndsAt).toEqual(trackedEndedAt);
      expect(timeline.overtime).toBe(true);
      expect(timeline.freeAt).toEqual(new Date("2027-09-04T23:51:12.000Z"));
      expect(timeline.protectedUntil).toEqual(new Date("2027-09-04T23:51:12.000Z"));
      // Overtime is purely an after-the-fact signal: it never moves the before-edge.
      expect(timeline.setupStartsAt).toEqual(commitmentTimeline(commitment(), 2).setupStartsAt);
    });

    it("counts a trackedEndedAt at or before endsAt for nothing", () => {
      const atEnd = commitmentTimeline(commitment({ trackedEndedAt: new Date("2027-09-04T23:00:00.000Z") }), 2);
      expect(atEnd.effectiveEndsAt).toEqual(new Date("2027-09-04T23:00:00.000Z"));
      expect(atEnd.overtime).toBe(false);

      const early = commitmentTimeline(commitment({ trackedEndedAt: new Date("2027-09-04T22:50:00.000Z") }), 2);
      expect(early.effectiveEndsAt).toEqual(new Date("2027-09-04T23:00:00.000Z"));
      expect(early.overtime).toBe(false);
    });
  });

  describe("latenessMatters", () => {
    it("defaults to true when absent", () => {
      expect(commitmentTimeline(commitment(), 2).latenessMatters).toBe(true);
    });

    it("carries an explicit false through unchanged", () => {
      expect(commitmentTimeline(commitment({ latenessMatters: false }), 2).latenessMatters).toBe(false);
    });

    it("carries an explicit true through unchanged", () => {
      expect(commitmentTimeline(commitment({ latenessMatters: true }), 2).latenessMatters).toBe(true);
    });
  });
});
