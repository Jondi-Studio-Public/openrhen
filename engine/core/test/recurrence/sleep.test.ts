import { describe, expect, it } from "vitest";
import { planSleep, type SleepPreferences } from "../../src/index.js";
import { assumedWakeAt } from "../../src/recurrence/sleep.js";

const preferences: SleepPreferences = {
  preferredBedtime: "22:00",
  preferredWakeTime: "06:00",
  desiredSleepMinutes: 480,
  minimumSleepMinutes: 360,
  maxAwakeHours: 20,
  bedtimeDeviationMinutes: 180,
  arrivalMarginMinutes: 2
};

describe("sleep planning", () => {
  // Reported 2027-08-17: woke 2:29am after a 380-minute night, and at 4:41am the planner still said
  // "time to sleep" — it anchored on that morning's 6am wake, found the bedtime it implied long past,
  // and replanned a start pinned to the calculation instant, so it re-slid on every recompute.
  it("does not re-issue a bedtime to someone who already slept that night", () => {
    const now = new Date("2027-08-16T18:41:00Z"); // 17 Aug 4:41am local
    const wokeAt = new Date("2027-08-16T16:29:00Z"); // 17 Aug 2:29am local, after 380 minutes asleep
    const early = {
      ...preferences,
      preferredBedtime: "21:15",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300
    };
    const slept = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: wokeAt,
      preferences: early,
      commitments: [],
      lastSleepMinutes: 380
    })[0]!;
    expect(slept.replannedFromMissedStart).toBe(false);
    expect(slept.plannedStartAt.getTime()).toBeGreaterThan(now.getTime() + 8 * 60 * 60_000);
    // A nap is not a night, so the bedtime it would have covered still stands.
    const napped = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: wokeAt,
      preferences: early,
      commitments: [],
      lastSleepMinutes: 20
    })[0]!;
    expect(napped.replannedFromMissedStart).toBe(true);
    expect(napped.plannedStartAt.toISOString()).toBe(now.toISOString());
    // An unknown duration behind a recorded wake cancels the bedtime too: only a *known* nap leaves
    // it standing. The old rule ("unknown must not cancel") turned one corrupted completed row —
    // wake recorded, start wiped, duration unknowable — into a full sleep obligation pinned to the
    // instant of calculation at 4:47 am, minutes after the user got up.
    expect(
      planSleep({ now, timezone: "Australia/Sydney", lastWokeAt: wokeAt, preferences: early, commitments: [] })[0]!
        .replannedFromMissedStart
    ).toBe(false);
  });
  // Reported 2027-08-27: a manually logged 298-minute night against a 300-minute minimum
  // was classified as a nap, which re-armed the missed bedtime and prescribed "Time to sleep (5 min)"
  // at 4:43 am, eight minutes after the user woke. A night within the 30-minute tolerance of the
  // minimum is the night, hand-rounded; a night well under it is still a nap.
  it("treats a night within tolerance of the minimum as slept, not as a nap", () => {
    const now = new Date("2027-08-27T18:51:00Z"); // 28 Aug 4:51am local
    const wokeAt = new Date("2027-08-27T18:43:00Z"); // 28 Aug 4:43am local
    const early = {
      ...preferences,
      preferredBedtime: "21:15",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300
    };
    const nearMiss = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: wokeAt,
      preferences: early,
      commitments: [],
      lastSleepMinutes: 298
    })[0]!;
    expect(nearMiss.replannedFromMissedStart).toBe(false);
    expect(nearMiss.plannedStartAt.getTime()).toBeGreaterThan(now.getTime() + 8 * 60 * 60_000);
    // 269 minutes is more than the 30-minute tolerance under the 300 minimum: a genuine nap.
    const stillANap = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: wokeAt,
      preferences: early,
      commitments: [],
      lastSleepMinutes: 269
    })[0]!;
    expect(stillANap.replannedFromMissedStart).toBe(true);
  });
  // Reported 2027-08-27: a before-phase step marked flexible with a 900-minute lead —
  // "prepare uniform", explicitly allowed the previous afternoon — was protected exactly like a
  // contiguous one and pinned every work night's wake to 4:33 am, 72 minutes short. A flexible step
  // whose lead window opens before the bedtime can be done the evening before, so only the first
  // contiguous step gates the wake.
  it("lets a pre-bed-doable flexible step yield the wake constraint to the first contiguous step", () => {
    const now = new Date("2027-08-10T11:00:00Z"); // 10 Aug 9:00pm local, an hour before bed
    const base = { ...preferences, desiredSleepMinutes: 540, minimumSleepMinutes: 300 };
    const flexibleStep = {
      id: "routine:prepare-uniform",
      title: "Prepare uniform",
      startsAt: new Date("2027-08-10T18:33:00Z"),
      endsAt: new Date("2027-08-10T18:48:00Z"),
      // Lead window opened 900 minutes before the 6:00am (20:00Z) commitment: 05:00Z, well before bedtime.
      flexibleLeadOpensAt: new Date("2027-08-10T05:00:00Z")
    };
    const contiguousStep = {
      id: "routine:eat-breakfast",
      title: "Eat Breakfast",
      startsAt: new Date("2027-08-10T18:48:00Z"),
      endsAt: new Date("2027-08-10T19:03:00Z")
    };
    const night = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T20:00:00Z"),
      preferences: base,
      commitments: [flexibleStep, contiguousStep],
      lastSleepMinutes: 540
    })[0]!;
    expect(night.wakeConstraint?.commitmentId).toBe("routine:eat-breakfast");
    expect(night.plannedWakeAt).toEqual(contiguousStep.startsAt);
    // A flexible step whose lead window only opens mid-sleep cannot be done before bed, so it still
    // gates the wake like any other protected range.
    const lateWindow = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T20:00:00Z"),
      preferences: base,
      commitments: [{ ...flexibleStep, flexibleLeadOpensAt: new Date("2027-08-10T16:00:00Z") }, contiguousStep],
      lastSleepMinutes: 540
    })[0]!;
    expect(lateWindow.wakeConstraint?.commitmentId).toBe("routine:prepare-uniform");
  });
  /**
   * Reported 2027-08-18: asked at 3am, after a bedtime that was missed rather than slept, the planner
   * agreed the night was gone (plan 1 starts now) — and then skipped straight over the coming evening,
   * putting the next night at 04:00 and each one after that an hour later again. The night after a
   * wake is the night that follows *that wake*, not a fixed number of days from the moment of asking.
   */
  const drift: SleepPreferences = {
    preferredBedtime: "22:30",
    preferredWakeTime: "06:30",
    desiredSleepMinutes: 480,
    minimumSleepMinutes: 360,
    maxAwakeHours: 17,
    bedtimeDeviationMinutes: 180,
    arrivalMarginMinutes: 2
  };
  it("returns to the preferred bedtime the evening after an early-morning missed bedtime", () => {
    const plans = planSleep({
      now: new Date("2027-08-17T17:00:00Z"), // 18 Aug 3:00am local
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-16T20:30:00Z"), // 17 Aug 6:30am local
      preferences: drift,
      commitments: []
    });
    // The bedtime that has already passed is honoured by sleeping now, and keeps the stable identity
    // that lets an in-progress bedtime routine
    // survive the recompute — the cycle's own date-keyed id, the same one an ordinary, not-yet-missed
    // call for this same night would have used a minute earlier, not a distinct id keyed on
    // `lastWokeAt` (finding 6: crossing into a missed start must never change the id).
    expect(plans[0]!.replannedFromMissedStart).toBe(true);
    expect(plans[0]!.plannedStartAt.toISOString()).toBe("2027-08-17T17:00:00.000Z");
    expect(plans[0]!.plannedWakeAt.toISOString()).toBe("2027-08-18T01:00:00.000Z");
    expect(plans[0]!.id).toBe("sleep:2027-08-18");
    // Tonight, 18 Aug 22:30 local — not the night after it, and not clamped to the awake limit.
    expect(plans[1]!.plannedStartAt.toISOString()).toBe("2027-08-18T12:30:00.000Z");
    expect(plans[1]!.plannedWakeAt.toISOString()).toBe("2027-08-18T20:30:00.000Z");
    expect(plans[2]!.plannedStartAt.toISOString()).toBe("2027-08-19T12:30:00.000Z");
    expect(plans[1]!.replannedFromMissedStart).toBe(false);
    expect(plans[1]!.hardErrors).toEqual([]);
  });
  it("keeps an ordinary evening on the preferred bedtime every night", () => {
    const plans = planSleep({
      now: new Date("2027-08-18T10:00:00Z"), // 18 Aug 8:00pm local
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-17T20:30:00Z"), // 18 Aug 6:30am local
      preferences: drift,
      commitments: [],
      lastSleepMinutes: 480
    });
    expect(plans[0]!.plannedStartAt.toISOString()).toBe("2027-08-18T12:30:00.000Z");
    expect(plans[0]!.plannedWakeAt.toISOString()).toBe("2027-08-18T20:30:00.000Z");
    expect(plans[1]!.plannedStartAt.toISOString()).toBe("2027-08-19T12:30:00.000Z");
    expect(plans[2]!.plannedStartAt.toISOString()).toBe("2027-08-20T12:30:00.000Z");
  });
  it("pulls an early riser's first night to the awake limit and settles back afterwards", () => {
    const plans = planSleep({
      now: new Date("2027-08-17T19:30:00Z"), // 18 Aug 5:30am local
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-17T19:00:00Z"), // 18 Aug 5:00am local
      preferences: drift,
      commitments: [],
      lastSleepMinutes: 450
    });
    // 17 waking hours from a 5am rise is 22:00, half an hour before the preferred bedtime.
    expect(plans[0]!.plannedStartAt.toISOString()).toBe("2027-08-18T12:00:00.000Z");
    expect(plans[1]!.plannedStartAt.toISOString()).toBe("2027-08-19T12:30:00.000Z");
    expect(plans[2]!.plannedStartAt.toISOString()).toBe("2027-08-20T12:30:00.000Z");
  });
  /**
   * The same rule stated over every moment rather than the three reported ones.
   *
   * Consecutive nights are not simply 24 hours apart: the awake limit legitimately pulls a night
   * earlier than its anchor, and recovering from that walks the bedtime back at one hour a night, so a
   * genuine cycle can run to sleep + awake-limit (25 hours here) until it catches up. What must never
   * happen — and is exactly what drifted — is a night landing *after* the first preferred bedtime that
   * followed the previous wake, which means a bedtime was skipped for no reason at all.
   */
  // Every quarter-hour is swept, with two of the five awake lengths each, rotating so every length
  // meets every hour of the day: 192 planner sweeps (~2s) instead of all 480 (~5s, which timed out
  // on a loaded CI runner).
  it("never skips a preferred bedtime between one night and the next", { timeout: 20_000 }, () => {
    // 22:30 local on each date, computed here rather than asked of the planner. August has no
    // transition in this zone, so the offset is a constant +10.
    const bedtimeAtOrAfter = (instant: Date) => {
      let candidate = Date.UTC(2026, 7, 15, 12, 30);
      while (candidate < instant.getTime()) candidate += 86_400_000;
      return candidate;
    };
    const ceiling = (drift.desiredSleepMinutes + drift.maxAwakeHours * 60) * 60_000;
    // Every quarter-hour across a whole day, so the answer cannot depend on catching a lucky moment.
    for (let quarter = 0; quarter < 96; quarter += 1) {
      const now = new Date(Date.UTC(2026, 7, 17, 0, 0, 0) + quarter * 15 * 60_000);
      const awakeLengths = [1, 5, 9, 14, 18];
      for (const awakeHours of [awakeLengths[quarter % 5]!, awakeLengths[(quarter + 2) % 5]!]) {
        const plans = planSleep({
          now,
          timezone: "Australia/Sydney",
          lastWokeAt: new Date(now.getTime() - awakeHours * 3_600_000),
          preferences: drift,
          commitments: []
        });
        expect(plans).toHaveLength(7);
        for (let index = 1; index < plans.length; index += 1) {
          const where = `${now.toISOString()} awake ${awakeHours}h, plan ${index}`;
          const previous = plans[index - 1]!;
          const plan = plans[index]!;
          expect(plan.plannedStartAt.getTime(), where).toBeLessThanOrEqual(bedtimeAtOrAfter(previous.plannedWakeAt));
          const gap = plan.plannedStartAt.getTime() - previous.plannedStartAt.getTime();
          expect(gap, where).toBeGreaterThan(0);
          expect(gap, where).toBeLessThanOrEqual(ceiling);
        }
      }
    }
  });
  // Sleep is a wall (2027-09-25 decision): the target is always `desiredSleepMinutes`, with no
  // aggression-driven reduction and no rounding.
  it("plans the full desired duration with nothing to protect against", () => {
    const result = planSleep({
      now: new Date("2027-08-09T08:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T00:00:00Z"),
      preferences: { ...preferences, desiredSleepMinutes: 470, minimumSleepMinutes: 360 },
      commitments: []
    })[0]!;
    expect(result.allowedMinutes).toBe(470);
    expect(result.targetMinutes).toBe(470);
  });
  it("moves sleep before a conflicting commitment", () => {
    const result = planSleep({
      now: new Date("2027-08-09T08:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T00:00:00Z"),
      preferences,
      commitments: [
        { id: "night", startsAt: new Date("2027-08-09T12:00:00Z"), endsAt: new Date("2027-08-09T14:00:00Z") }
      ]
    });
    expect(result).toHaveLength(7);
    // Starting right after the conflict ends is much closer to the preferred bedtime (2h late) than
    // walking back into the afternoon would be (10h early), so it wins and gets the full night besides.
    expect(result[0]!.plannedStartAt.toISOString()).toBe("2027-08-09T14:00:00.000Z");
    expect(result[0]!.plannedWakeAt.toISOString()).toBe("2027-08-09T22:00:00.000Z");
    expect(result[0]!.allowedMinutes).toBe(480);
  });
  // A protected commitment's ideal walk-back bedtime (conflict start minus the
  // target duration) had passed by 8 minutes at the moment the plan was computed, so the walk-back
  // branch above was skipped entirely and the plan fell through to the plain-truncate path anchored at
  // the untouched preferred bedtime - offering 480 minutes when starting right now would still have
  // kept 532 of the full 540-minute target.
  it("walks back to now instead of the anchor bedtime once the ideal walk-back instant has just passed", () => {
    const bedtimePrefs: SleepPreferences = {
      ...preferences,
      preferredBedtime: "20:50",
      preferredWakeTime: "05:50",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300,
      maxAwakeHours: 20
    };
    const now = new Date("2027-08-09T09:48:00Z"); // 19:48 local - 8 minutes past the 19:40 ideal walk-back
    const result = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T00:00:00Z"),
      preferences: bedtimePrefs,
      commitments: [
        {
          id: "early-call",
          startsAt: new Date("2027-08-09T18:40:00Z"), // 04:40 local the next morning
          endsAt: new Date("2027-08-09T18:50:00Z")
        }
      ]
    })[0]!;
    expect(result.replannedFromMissedStart).toBe(false);
    expect(result.plannedStartAt.toISOString()).toBe(now.toISOString());
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T18:40:00.000Z");
    expect(result.allowedMinutes).toBe(532);
  });
  // The night's bedtime sat behind a chain of contiguous routine steps
  // (each ending exactly where the next begins). The conflict loop used to filter the overlapping
  // ranges once against the untouched anchor window and then walk every one of them in turn, so each
  // later link re-anchored the walk-back on ITS OWN ideal instant - strictly later than the true
  // earliest one - and the final link always won. Walking back before the EARLIEST binding conflict
  // clears every later one in the same contiguous chain, so the loop must re-derive the overlap set
  // from the window each resolution produces rather than iterate a stale list.
  it("walks back before the earliest conflict in a chain of contiguous conflicts, not the last one", () => {
    const bedtimePrefs: SleepPreferences = {
      ...preferences,
      preferredBedtime: "20:50",
      preferredWakeTime: "05:50",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300,
      maxAwakeHours: 20
    };
    const result = planSleep({
      now: new Date("2027-08-09T00:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T00:00:00Z"),
      preferences: bedtimePrefs,
      commitments: [
        // Three contiguous steps preparing a single early commitment, same shape as the reported chain.
        { id: "c1", startsAt: new Date("2027-08-09T18:00:00Z"), endsAt: new Date("2027-08-09T18:15:00Z") },
        { id: "c2", startsAt: new Date("2027-08-09T18:15:00Z"), endsAt: new Date("2027-08-09T18:30:00Z") },
        { id: "c3", startsAt: new Date("2027-08-09T18:30:00Z"), endsAt: new Date("2027-08-09T18:45:00Z") }
      ]
    })[0]!;
    // Before the fix this landed on c3's ideal instant (2027-08-09T09:30:00.000Z, a 510-minute night);
    // the earliest conflict (c1) is the one that actually binds, at the full 540-minute target.
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-09T09:00:00.000Z");
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T18:00:00.000Z");
    expect(result.allowedMinutes).toBe(540);
  });
  // A commitment already under way when the plan is computed - its protected range starts before "now"
  // and ends after it - sat in the path of the walk-back toward a later conflict. The clamped-to-now
  // branch above naively truncated `end` to that in-progress conflict's own start, which is at or before
  // "now" itself: a zero-or-negative-length window. It must fall through to "start after the conflict"
  // instead, the same as any other conflict the window's start already lands inside.
  it("starts after a conflict that is already under way, instead of producing a zero-length window", () => {
    const bedtimePrefs: SleepPreferences = {
      ...preferences,
      preferredBedtime: "20:50",
      preferredWakeTime: "05:50",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300,
      maxAwakeHours: 20
    };
    const result = planSleep({
      now: new Date("2027-08-09T09:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences: bedtimePrefs,
      commitments: [
        // Spans "now": started half an hour ago, runs half an hour more.
        { id: "ongoing", startsAt: new Date("2027-08-09T08:30:00Z"), endsAt: new Date("2027-08-09T09:30:00Z") },
        // Would otherwise pull bedtime back into the middle of the ongoing commitment.
        { id: "later", startsAt: new Date("2027-08-09T18:40:00Z"), endsAt: new Date("2027-08-09T18:50:00Z") }
      ]
    })[0]!;
    expect(result.plannedWakeAt.getTime()).toBeGreaterThan(result.plannedStartAt.getTime());
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-09T09:30:00.000Z");
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T18:30:00.000Z");
    expect(result.allowedMinutes).toBe(540);
  });
  // A conflict that itself runs past the max-awake limit (its protected range ends after `latestStart`)
  // must still resolve deterministically to "start right after it, and report the limit as violated" -
  // not loop, and not silently understate the violation by stopping at the limit instead of the
  // conflict's real end.
  it("starts right after a conflict that ends past the awake limit, and reports the violation", () => {
    const bedtimePrefs: SleepPreferences = {
      ...preferences,
      preferredBedtime: "20:50",
      preferredWakeTime: "05:50",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300,
      maxAwakeHours: 10
    };
    const result = planSleep({
      now: new Date("2027-08-09T09:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences: bedtimePrefs,
      commitments: [
        // Straddles the 10-hour awake limit (2027-08-09T06:00:00Z): starts before it, ends after it.
        { id: "blocker", startsAt: new Date("2027-08-09T05:00:00Z"), endsAt: new Date("2027-08-09T10:00:00Z") }
      ]
    })[0]!;
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-09T10:00:00.000Z");
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T19:00:00.000Z");
    expect(result.allowedMinutes).toBe(540);
    expect(result.hardErrors).toContain("Sleep starts after the 10-hour awake limit.");
  });
  // Finding 7: a passed awake limit used to give a bedtime an hour in the past (the awake-limit clamp
  // pinned the start at 08:00Z, which was already behind "now"). Night 0 never starts before now: this
  // is a missed start instead, explained as the awake limit having already passed.
  it("starts now, not in the past, once the awake limit has already been passed", () => {
    const bedtimePrefs: SleepPreferences = {
      ...preferences,
      preferredBedtime: "20:50",
      preferredWakeTime: "05:50",
      desiredSleepMinutes: 540,
      minimumSleepMinutes: 300,
      maxAwakeHours: 12
    };
    const now = new Date("2027-08-09T09:48:00Z"); // 19:48 local
    const result = planSleep({
      now,
      timezone: "Australia/Sydney",
      // Awake since 06:00 the same morning: by 19:48 the 12-hour awake limit is already 1h48m behind.
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences: bedtimePrefs,
      commitments: [
        { id: "early-call", startsAt: new Date("2027-08-09T16:00:00Z"), endsAt: new Date("2027-08-09T16:05:00Z") }
      ]
    })[0]!;
    expect(result.replannedFromMissedStart).toBe(true);
    expect(result.plannedStartAt.toISOString()).toBe(now.toISOString());
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T16:00:00.000Z");
    expect(result.hardErrors).toContain("The awake limit has already passed.");
  });
  it("balances bedtime and wake anchors on deterministic 15-minute boundaries", () => {
    const result = planSleep({
      now: new Date("2027-08-09T08:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T00:00:00Z"),
      preferences: { ...preferences, preferredBedtime: "21:00", desiredSleepMinutes: 420 },
      commitments: []
    })[0]!;
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-09T12:00:00.000Z");
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T19:00:00.000Z");
    expect(result.anchorDeviationMinutes).toBe(120);
  });
  it("reports an unavoidable awake-limit violation", () => {
    const result = planSleep({
      now: new Date("2027-08-09T08:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T00:00:00Z"),
      preferences,
      commitments: [
        { id: "blocked", startsAt: new Date("2027-08-08T00:00:00Z"), endsAt: new Date("2027-08-10T00:00:00Z") }
      ]
    });
    expect(result[0]!.hardErrors.length).toBeGreaterThan(0);
  });
  it("starts overdue sleep now and moves wake to protect the full desired target", () => {
    const now = new Date("2027-08-11T14:07:00Z");
    const result = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T22:00:00Z"),
      preferences: { ...preferences, desiredSleepMinutes: 540, minimumSleepMinutes: 240 },
      commitments: []
    });
    expect(result[0]!.plannedStartAt.toISOString()).toBe("2027-08-11T14:07:00.000Z");
    expect(result[0]!.plannedWakeAt.toISOString()).toBe("2027-08-11T23:07:00.000Z");
    expect(result[0]!.allowedMinutes).toBe(540);
    expect(result[0]!.minimumShortfallMinutes).toBe(0);
    expect(result[0]!.replannedFromMissedStart).toBe(true);
    expect(result[0]!.hardErrors).toContain("Sleep starts after the 20-hour awake limit.");
    expect(result.every((plan) => plan.plannedStartAt >= now)).toBe(true);
  });
  it("regresses the stale 5:45 wake by protecting the full 9 hours after a 3 am start", () => {
    const result = planSleep({
      now: new Date("2027-08-10T17:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T22:00:00Z"),
      preferences: {
        ...preferences,
        preferredBedtime: "20:50",
        preferredWakeTime: "06:00",
        desiredSleepMinutes: 540,
        minimumSleepMinutes: 300
      },
      commitments: []
    })[0]!;
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-10T17:00:00.000Z");
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-11T02:00:00.000Z");
    expect(result.allowedMinutes).toBe(540);
    expect(result.minimumShortfallMinutes).toBe(0);
  });
  it("allows only a passed confirmed commitment to constrain sleep below minimum", () => {
    const now = new Date("2027-08-10T17:00:00Z");
    const commitment = {
      id: "work",
      title: "Work",
      startsAt: new Date("2027-08-10T20:00:00Z"),
      endsAt: new Date("2027-08-11T04:00:00Z")
    };
    const constrained = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T22:00:00Z"),
      preferences: { ...preferences, desiredSleepMinutes: 540, minimumSleepMinutes: 300 },
      commitments: [commitment]
    })[0]!;
    expect(constrained.plannedWakeAt).toEqual(commitment.startsAt);
    expect(constrained.allowedMinutes).toBe(180);
    expect(constrained.minimumShortfallMinutes).toBe(120);
    expect(constrained.wakeConstraint).toMatchObject({ commitmentId: "work", title: "Work" });
    expect(constrained.hardErrors[0]).toContain("Minimum sleep cannot be met");
    const tentativeIgnored = planSleep({
      now,
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T22:00:00Z"),
      preferences: { ...preferences, desiredSleepMinutes: 540, minimumSleepMinutes: 300 },
      commitments: []
    })[0]!;
    expect(tentativeIgnored.allowedMinutes).toBe(540);
  });
  it("includes confirmed commitment setup in the hard wake boundary", () => {
    const result = planSleep({
      now: new Date("2027-08-10T17:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-09T22:00:00Z"),
      preferences: { ...preferences, desiredSleepMinutes: 540, minimumSleepMinutes: 300 },
      commitments: [
        {
          id: "work",
          title: "Work",
          startsAt: new Date("2027-08-10T20:00:00Z"),
          endsAt: new Date("2027-08-11T04:00:00Z"),
          setupBeforeMinutes: 30
        }
      ]
    })[0]!;
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-10T19:30:00.000Z");
    expect(result.allowedMinutes).toBe(150);
  });

  // an evening dinner running past bedtime used to walk the whole night back in front of it. The
  // fix starts after the dinner (plus the routine), reading as "near bedtime" rather than a warning.
  it("starts after an evening dinner instead of walking the whole night back before it", () => {
    const result = planSleep({
      now: new Date("2027-08-09T00:00:00Z"), // well before the evening
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences,
      bedtimeRoutineMinutes: 20,
      commitments: [
        // 19:00-22:40 local: overlaps the 22:00 preferred bedtime by 40 minutes.
        {
          id: "dinner",
          title: "Dinner",
          startsAt: new Date("2027-08-09T09:00:00Z"),
          endsAt: new Date("2027-08-09T12:40:00Z")
        }
      ]
    })[0]!;
    // 22:40 local + 20 minutes of routine = 23:00 local = 13:00Z, close to the 22:00 preferred bedtime.
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-09T13:05:00.000Z");
    expect(result.deviationOptions).toBeUndefined();
  });
  // The other evening case, and the flight case the decision text names directly: an early departure
  // still walks bedtime back to protect the full night, because there is nothing to start "after".
  it("walks a 05:00 flight back to 21:00 to protect the full night", () => {
    const result = planSleep({
      now: new Date("2027-08-09T00:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences,
      commitments: [
        // 05:00 local the next morning.
        {
          id: "flight",
          title: "Flight",
          startsAt: new Date("2027-08-09T19:00:00Z"),
          endsAt: new Date("2027-08-09T21:00:00Z")
        }
      ]
    })[0]!;
    expect(result.plannedStartAt.toISOString()).toBe("2027-08-09T11:00:00.000Z"); // 21:00 local
    expect(result.plannedWakeAt.toISOString()).toBe("2027-08-09T19:00:00.000Z"); // 05:00 local
  });

  it("plans the desired 470 minutes as 470, with no aggression-style reduction", () => {
    const result = planSleep({
      now: new Date("2027-08-09T00:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences: { ...preferences, desiredSleepMinutes: 470 },
      commitments: []
    })[0]!;
    expect(result.allowedMinutes).toBe(470);
    expect(result.targetMinutes).toBe(470);
  });

  // Finding 4: a kept night (already `sleeping`, or an overridden `planned` row) is not recomputed, and
  // the following night chains from its real wake rather than a discarded calculated one.
  it("chains the next night from a kept night's real wake", () => {
    const keptWake = new Date("2027-08-09T23:00:00Z"); // 09:00am local, much later than the usual 06:00
    const result = planSleep({
      now: new Date("2027-08-09T12:00:00Z"),
      timezone: "Australia/Sydney",
      lastWokeAt: new Date("2027-08-08T20:00:00Z"),
      preferences,
      commitments: [],
      keptNights: [{ id: "kept-1", startsAt: new Date("2027-08-09T12:00:00Z"), wakesAt: keptWake }]
    });
    // The kept cycle produces no competing plan of its own...
    expect(result.some((plan) => overlapsRange(plan, new Date("2027-08-09T12:00:00Z"), keptWake))).toBe(false);
    // ...and the very next night starts from the kept night's actual (late) wake, not the usual 06:00.
    expect(result[0]!.plannedStartAt.getTime()).toBeGreaterThanOrEqual(keptWake.getTime());
  });

  describe("night identity", () => {
    it("keeps the same cycle id across a moved start", () => {
      const early = planSleep({
        now: new Date("2027-08-09T00:00:00Z"),
        timezone: "Australia/Sydney",
        lastWokeAt: new Date("2027-08-08T20:00:00Z"),
        preferences,
        commitments: []
      })[0]!;
      const later = planSleep({
        now: new Date("2027-08-09T11:00:00Z"),
        timezone: "Australia/Sydney",
        lastWokeAt: new Date("2027-08-08T20:00:00Z"),
        preferences,
        commitments: [{ id: "c", startsAt: new Date("2027-08-09T11:30:00Z"), endsAt: new Date("2027-08-09T12:00:00Z") }]
      })[0]!;
      expect(later.id).toBe(early.id);
    });
    it("gives a nap that re-arms a completed cycle its own distinct id", () => {
      const lastWokeAt = new Date("2027-08-08T20:00:00Z");
      const plain = planSleep({
        now: new Date("2027-08-09T00:00:00Z"),
        timezone: "Australia/Sydney",
        lastWokeAt,
        preferences,
        commitments: []
      })[0]!;
      const afterNap = planSleep({
        now: new Date("2027-08-09T00:00:00Z"),
        timezone: "Australia/Sydney",
        lastWokeAt,
        preferences,
        commitments: [],
        isCompleted: (rawKey) => rawKey === plain.id
      })[0]!;
      expect(afterNap.id).not.toBe(plain.id);
      expect(afterNap.id.startsWith(`${plain.id}:after:`)).toBe(true);
    });
  });

  describe("bedtime deviation", () => {
    const shiftPrefs: SleepPreferences = {
      preferredBedtime: "22:00",
      preferredWakeTime: "06:00",
      desiredSleepMinutes: 480,
      minimumSleepMinutes: 300,
      maxAwakeHours: 15.5,
      bedtimeDeviationMinutes: 180,
      arrivalMarginMinutes: 0
    };
    // A short late-evening event (23:00-23:30) sits right at the far edge of the full 8-hour night, so
    // walking bedtime back before it reaches the full desired duration
    // only by starting at 15:00 — more than 180 minutes (the configured deviation) before the 22:00
    // preferred bedtime. That is the early/near split: the full night is placed by default (with a
    // warning), and the near night — starting right at the preferred bedtime, truncated by the same
    // event down to 60 minutes — is offered alongside it.
    const eveningEvent = {
      id: "event",
      title: "Late event",
      startsAt: new Date("2027-01-01T23:00:00Z"),
      endsAt: new Date("2027-01-01T23:30:00Z")
    };
    const now = new Date("2027-01-01T08:00:00Z");
    const lastWokeAt = new Date("2027-01-01T07:00:00Z");
    it("defaults to the full early night with a standing warning", () => {
      const result = planSleep({
        now,
        timezone: "UTC",
        lastWokeAt,
        preferences: shiftPrefs,
        commitments: [eveningEvent]
      })[0]!;
      expect(result.plannedStartAt).toEqual(new Date("2027-01-01T15:00:00.000Z"));
      expect(result.allowedMinutes).toBe(480);
      expect(result.placementChoice).toBeUndefined();
      expect(result.deviationOptions).toEqual({
        early: {
          startsAt: new Date("2027-01-01T15:00:00.000Z"),
          wakesAt: new Date("2027-01-01T23:00:00.000Z"),
          minutes: 480
        },
        near: {
          startsAt: new Date("2027-01-01T22:00:00.000Z"),
          wakesAt: new Date("2027-01-01T23:00:00.000Z"),
          minutes: 60
        },
        warn: true
      });
    });
    it("switches to the near night once `near` is recorded", () => {
      const result = planSleep({
        now,
        timezone: "UTC",
        lastWokeAt,
        preferences: shiftPrefs,
        commitments: [eveningEvent],
        answers: () => ({ placementChoice: "near" })
      })[0]!;
      expect(result.placementChoice).toBe("near");
      expect(result.deviationOptions?.warn).toBe(false);
      expect(result.plannedStartAt).toEqual(new Date("2027-01-01T22:00:00.000Z"));
      expect(result.allowedMinutes).toBe(60);
    });
    it("keeps the early night and clears the warning once `early` is recorded", () => {
      const result = planSleep({
        now,
        timezone: "UTC",
        lastWokeAt,
        preferences: shiftPrefs,
        commitments: [eveningEvent],
        answers: () => ({ placementChoice: "early" })
      })[0]!;
      expect(result.placementChoice).toBe("early");
      expect(result.allowedMinutes).toBe(480);
      expect(result.deviationOptions?.warn).toBe(false);
      expect(result.plannedStartAt).toEqual(new Date("2027-01-01T15:00:00.000Z"));
    });
    it("lapses to starting now while that still beats the near night", () => {
      // 15:30, half an hour past the early night's own 15:00 start: unanswered, so sleep starts now —
      // still 450 minutes, more than the 60-minute near night.
      const result = planSleep({
        now: new Date("2027-01-01T15:30:00Z"),
        timezone: "UTC",
        lastWokeAt,
        preferences: shiftPrefs,
        commitments: [eveningEvent]
      })[0]!;
      expect(result.replannedFromMissedStart).toBe(true);
      expect(result.plannedStartAt).toEqual(new Date("2027-01-01T15:30:00.000Z"));
      expect(result.allowedMinutes).toBe(450);
      expect(result.deviationOptions?.warn).toBe(true);
      expect(result.placementChoice).toBeUndefined();
    });
    it("falls to the near night once starting now would sleep less than it", () => {
      // A second, much earlier commitment (15:20-15:35) sits inside the early night's own window but
      // well before the near night's — so the early night, evaluated fresh right at its own 15:00 start,
      // is truncated down to 20 minutes: less than the 60-minute near night. Unanswered, the lapse falls
      // back to near instead of starting now.
      const daytimeThing = {
        id: "daytime-thing",
        title: "Daytime thing",
        startsAt: new Date("2027-01-01T15:20:00Z"),
        endsAt: new Date("2027-01-01T15:35:00Z")
      };
      const result = planSleep({
        now: new Date("2027-01-01T15:00:00Z"),
        timezone: "UTC",
        lastWokeAt,
        preferences: shiftPrefs,
        commitments: [eveningEvent, daytimeThing]
      })[0]!;
      expect(result.placementChoice).toBe("near");
      expect(result.deviationOptions?.warn).toBe(false);
      expect(result.plannedStartAt).toEqual(new Date("2027-01-01T22:00:00.000Z"));
      expect(result.allowedMinutes).toBe(60);
    });
  });
});

describe("a night planned from an assumed wake", () => {
  it("assumes the latest preferred wake time at or before now, in the person's timezone", () => {
    // 06:00 local is 20:00Z the day before (AEST, UTC+10, in August).
    const seedZone = (now: string) => assumedWakeAt(new Date(now), "Australia/Sydney", "06:00").toISOString();
    expect(seedZone("2027-08-17T02:00:00Z")).toBe("2027-08-16T20:00:00.000Z"); // noon seed-zone: this morning's
    expect(seedZone("2027-08-16T20:00:00Z")).toBe("2027-08-16T20:00:00.000Z"); // exactly 06:00: now
    expect(seedZone("2027-08-16T18:00:00Z")).toBe("2027-08-15T20:00:00.000Z"); // 04:00 local: yesterday's
  });

  const night = (nowAt: string, assumedWake: boolean) => {
    const now = new Date(nowAt);
    return planSleep({
      now,
      timezone: "UTC",
      // 15 hours awake at 21:00 from the 06:00 wake, against a 14-hour limit.
      lastWokeAt: assumedWakeAt(now, "UTC", "06:00"),
      ...(assumedWake ? { assumedWake: true } : {}),
      preferences: { ...preferences, maxAwakeHours: 14, bedtimeDeviationMinutes: 60 },
      commitments: []
    })[0]!;
  };

  it("puts no awake limit on the first night, which a recorded wake of the same time would", () => {
    const guessed = night("2027-08-17T21:00:00Z", true);
    expect(guessed.hardErrors).toEqual([]);
    expect(guessed.replannedFromMissedStart).toBe(false);
    expect(guessed.plannedStartAt.toISOString()).toBe("2027-08-17T22:00:00.000Z");
    expect(guessed.explanation).toContain("Planned from the sleep preferences because the last wake is unknown.");
    const recorded = night("2027-08-17T21:00:00Z", false);
    expect(recorded.hardErrors).toContain("The awake limit has already passed.");
    expect(recorded.explanation).not.toContain("last wake is unknown");
  });

  it("still misses a preferred bedtime that has already passed", () => {
    const missed = night("2027-08-17T22:40:00Z", true);
    expect(missed.replannedFromMissedStart).toBe(true);
    expect(missed.plannedStartAt.toISOString()).toBe("2027-08-17T22:40:00.000Z");
    expect(missed.hardErrors).toEqual([]);
  });

  it("leaves the nights after the first to the ordinary awake limit", () => {
    const now = new Date("2027-08-17T21:00:00Z");
    const plans = planSleep({
      now,
      timezone: "UTC",
      lastWokeAt: assumedWakeAt(now, "UTC", "06:00"),
      assumedWake: true,
      preferences: { ...preferences, maxAwakeHours: 14, bedtimeDeviationMinutes: 60 },
      commitments: []
    });
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[1]!.explanation).not.toContain("last wake is unknown");
  });
});

function overlapsRange(plan: { plannedStartAt: Date; plannedWakeAt: Date }, startsAt: Date, endsAt: Date): boolean {
  return plan.plannedStartAt < endsAt && plan.plannedWakeAt > startsAt;
}
