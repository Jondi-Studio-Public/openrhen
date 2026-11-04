import { describe, expect, it } from "vitest";
import {
  atRiskHealth,
  effortAge,
  nextStaleAt,
  openSessionTitle,
  projectHealthFromSchedule,
  resolveFreshness,
  sessionEndQuestion,
  spanLabel,
  type EffortAction,
  type FreshnessState
} from "./freshness.js";
import {
  ACTIVITY_STALE_GRACE_HOURS,
  DEFAULT_LOCATION_STALE_AFTER_MINUTES,
  EFFORT_STALE_DAYS,
  ENERGY_STALE_HOURS,
  PAUSED_SESSION_STALE_HOURS,
  SESSION_STALE_MIN_GRACE_MINUTES,
  WAKE_STALE_GRACE_HOURS
} from "./context-constants.js";
import { resolveSituation } from "./context-match.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const now = new Date("2026-10-27T21:20:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(now.getTime() + ms).toISOString();

type Session = NonNullable<FreshnessState["activeSession"]>;

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    actionId: "action-1",
    status: "running",
    targetType: "action",
    targetId: "action-1",
    startedAt: ago(19 * HOUR),
    plannedEndAt: ago(18 * HOUR + 15 * MINUTE),
    plannedMinutes: 45,
    remainingBeforeMinutes: 60,
    activeElapsedSeconds: 0,
    ...overrides
  };
}

function state(overrides: Partial<FreshnessState> = {}): FreshnessState {
  return {
    settings: { maxAwakeHours: 20, lastWokeAt: ago(2 * HOUR) },
    activeSession: null,
    currentSituation: { locationId: "home", locationSetAt: ago(HOUR), energySetAt: ago(HOUR) },
    ...overrides
  };
}

describe("resolveFreshness", () => {
  it("calls a state with every fact recent fresh", () => {
    const result = resolveFreshness(state(), now);
    expect(result.wake.stale).toBe(false);
    expect(result.session.stale).toBe(false);
    expect(result.energy.stale).toBe(false);
    expect(result.location.stale).toBe(false);
  });

  describe("wake", () => {
    it("is stale from the awake limit plus two hours on", () => {
      const limit = (20 + WAKE_STALE_GRACE_HOURS) * HOUR;
      const settings = (age: number) => ({ maxAwakeHours: 20, lastWokeAt: ago(age) });
      expect(resolveFreshness(state({ settings: settings(limit - MINUTE) }), now).wake.stale).toBe(false);
      expect(resolveFreshness(state({ settings: settings(limit) }), now).wake.stale).toBe(true);
      expect(resolveFreshness(state({ settings: settings(21 * 24 * HOUR) }), now).wake.stale).toBe(true);
    });

    it("uses his own awake limit, so a shorter limit goes stale sooner", () => {
      const settings = { maxAwakeHours: 14, lastWokeAt: ago(17 * HOUR) };
      expect(resolveFreshness(state({ settings }), now).wake.stale).toBe(true);
      expect(resolveFreshness(state({ settings: { ...settings, maxAwakeHours: 16 } }), now).wake.stale).toBe(false);
    });

    it("dates when it goes stale, and says nothing when no wake was ever told", () => {
      const woke = ago(HOUR);
      const result = resolveFreshness(state({ settings: { maxAwakeHours: 16, lastWokeAt: woke } }), now);
      expect(result.wake.asOf).toBe(woke);
      expect(result.wake.staleAt).toBe(new Date(new Date(woke).getTime() + 18 * HOUR).toISOString());
      expect(resolveFreshness(state({ settings: { maxAwakeHours: 16 } }), now).wake).toEqual({ stale: false });
    });
  });

  describe("session", () => {
    it("is stale for an action once the planned end plus the longer of an hour and the planned length has passed", () => {
      // Planned 45 minutes, so an hour of grace.
      const base = { plannedMinutes: 45 };
      const at = (past: number) => session({ ...base, plannedEndAt: ago(past) });
      const grace = SESSION_STALE_MIN_GRACE_MINUTES * MINUTE;
      expect(resolveFreshness(state({ activeSession: at(grace - MINUTE) }), now).session.stale).toBe(false);
      expect(resolveFreshness(state({ activeSession: at(grace) }), now).session.stale).toBe(true);
      // Planned 3 hours: the grace is the planned length, not the hour.
      const long = (past: number) => session({ plannedMinutes: 180, plannedEndAt: ago(past) });
      expect(resolveFreshness(state({ activeSession: long(2 * HOUR) }), now).session.stale).toBe(false);
      expect(resolveFreshness(state({ activeSession: long(3 * HOUR) }), now).session.stale).toBe(true);
    });

    it("holds for a running, a feedback and a deliverable session alike", () => {
      const old = { plannedEndAt: ago(18 * HOUR) };
      for (const overrides of [{ status: "running" }, { status: "feedback" }, { targetType: "deliverable" }] as const) {
        const result = resolveFreshness(state({ activeSession: session({ ...old, ...overrides }) }), now);
        expect(result.session.stale).toBe(true);
        expect(result.session.asOf).toBe(old.plannedEndAt);
      }
    });

    it("ages a paused session from the pause, not from the planned end", () => {
      const paused = (pausedAgo: number) =>
        session({ status: "paused", plannedEndAt: ago(18 * HOUR), pausedAt: ago(pausedAgo) });
      const limit = PAUSED_SESSION_STALE_HOURS * HOUR;
      expect(resolveFreshness(state({ activeSession: paused(limit - MINUTE) }), now).session.stale).toBe(false);
      expect(resolveFreshness(state({ activeSession: paused(limit) }), now).session.stale).toBe(true);
      expect(resolveFreshness(state({ activeSession: paused(HOUR) }), now).session.asOf).toBe(ago(HOUR));
    });

    it("ages a session paused and then moved to feedback from the pause too", () => {
      const parked = session({
        status: "feedback",
        pausedRemainingSeconds: 600,
        plannedEndAt: ago(HOUR),
        pausedAt: ago(PAUSED_SESSION_STALE_HOURS * HOUR)
      });
      const result = resolveFreshness(state({ activeSession: parked }), now).session;
      expect(result).toMatchObject({ stale: true, asOf: ago(PAUSED_SESSION_STALE_HOURS * HOUR) });
      expect(sessionEndQuestion(parked, now)).toBe("Paused 4 h ago. Finish it?");
    });

    it("falls back to the planned end for a paused session that was never dated", () => {
      const undated = session({ status: "paused", plannedEndAt: ago(ACTIVITY_STALE_GRACE_HOURS * HOUR) });
      expect(resolveFreshness(state({ activeSession: undated }), now).session.stale).toBe(true);
    });

    it("gives a routine step or a commitment four hours past the planned end", () => {
      const limit = ACTIVITY_STALE_GRACE_HOURS * HOUR;
      for (const targetType of ["routine_step", "fixed_commitment"] as const) {
        const at = (past: number) => session({ targetType, plannedEndAt: ago(past) });
        expect(resolveFreshness(state({ activeSession: at(limit - MINUTE) }), now).session.stale).toBe(false);
        expect(resolveFreshness(state({ activeSession: at(limit) }), now).session.stale).toBe(true);
      }
    });

    it("never calls sleep a forgotten session", () => {
      const asleep = session({ targetType: "sleep", plannedEndAt: ago(30 * HOUR) });
      expect(resolveFreshness(state({ activeSession: asleep }), now).session).toEqual({ stale: false });
    });

    it("treats a session with no target type as an action", () => {
      const { targetType: _targetType, ...legacy } = session({ plannedEndAt: ago(18 * HOUR) });
      expect(resolveFreshness(state({ activeSession: legacy }), now).session.stale).toBe(true);
    });
  });

  describe("energy", () => {
    it("reads as stale when it was never dated", () => {
      const result = resolveFreshness(
        state({ currentSituation: { locationId: "home", locationSetAt: ago(HOUR) } }),
        now
      );
      expect(result.energy).toEqual({ stale: true });
    });

    it("is stale from eight hours old on", () => {
      const said = (age: number) =>
        state({ settings: { maxAwakeHours: 20 }, currentSituation: { locationId: null, energySetAt: ago(age) } });
      expect(resolveFreshness(said(ENERGY_STALE_HOURS * HOUR - MINUTE), now).energy.stale).toBe(false);
      expect(resolveFreshness(said(ENERGY_STALE_HOURS * HOUR), now).energy.stale).toBe(true);
    });

    it("is stale when it was said before the last wake, however recent", () => {
      const result = resolveFreshness(
        state({
          settings: { maxAwakeHours: 20, lastWokeAt: ago(HOUR) },
          currentSituation: { locationId: null, energySetAt: ago(2 * HOUR) }
        }),
        now
      );
      expect(result.energy.stale).toBe(true);
      expect(result.energy.asOf).toBe(ago(2 * HOUR));
    });

    it("stays fresh when it was said after the last wake", () => {
      const result = resolveFreshness(
        state({
          settings: { maxAwakeHours: 20, lastWokeAt: ago(3 * HOUR) },
          currentSituation: { locationId: null, energySetAt: ago(HOUR) }
        }),
        now
      );
      expect(result.energy.stale).toBe(false);
    });
  });

  describe("location", () => {
    it("agrees with resolveSituation about when a place goes stale", () => {
      for (const minutes of [
        10,
        DEFAULT_LOCATION_STALE_AFTER_MINUTES - 1,
        DEFAULT_LOCATION_STALE_AFTER_MINUTES,
        481,
        3 * 24 * 60
      ]) {
        const currentSituation = { locationId: "home", locationSetAt: ago(minutes * MINUTE) };
        const fresh = resolveFreshness(state({ currentSituation }), now).location;
        const resolved = resolveSituation({
          situation: {
            ...currentSituation,
            overrides: {},
            carrying: {},
            transportModes: ["car"],
            travel: {},
            travelOff: false
          },
          definitions: [],
          now
        });
        expect(fresh.stale, `${minutes} minutes`).toBe(resolved.locationStale);
      }
    });

    it("has nothing to age when no place is asserted", () => {
      expect(
        resolveFreshness(state({ currentSituation: { locationId: null, locationSetAt: ago(9 * HOUR) } }), now).location
      ).toEqual({ stale: false });
    });
  });

  describe("effort", () => {
    const DAY = 24 * HOUR;
    const limit = EFFORT_STALE_DAYS * DAY;

    function action(overrides: Partial<EffortAction> = {}): EffortAction {
      return {
        id: "action-1",
        projectId: "project-1",
        title: "Draft chapter 3",
        status: "active",
        remainingMinutes: 180,
        remainingSetAt: ago(21 * DAY),
        schedulingMode: "one_off",
        ...overrides
      };
    }

    const health = (value: string, projectId = "project-1") => new Map([[projectId, value]]);
    const effort = (actions: EffortAction[], projectHealth: ReadonlyMap<string, string> | undefined) =>
      resolveFreshness(state({ actions }), now, projectHealth ? { projectHealth } : {}).effort;

    it("is empty without a project health to judge at risk by, as the engine calls it", () => {
      expect(effort([action()], undefined)).toEqual([]);
      expect(resolveFreshness(state({ actions: [action()] }), now).effort).toEqual([]);
    });

    it("is stale from 14 days on, and only while the project is behind or at risk", () => {
      const at = (age: number) => effort([action({ remainingSetAt: ago(age) })], health("at_risk"));
      expect(at(limit - MINUTE)[0]).toMatchObject({ stale: false });
      expect(at(limit)[0]).toMatchObject({ stale: true, staleAt: now.toISOString() });
      expect(at(21 * DAY)[0]).toMatchObject({
        stale: true,
        asOf: ago(21 * DAY),
        staleAt: ago(7 * DAY),
        actionId: "action-1",
        remainingMinutes: 180,
        health: "at_risk"
      });
      for (const comfortable of ["on_track", "ahead", "unknown"])
        expect(effort([action()], health(comfortable)), comfortable).toEqual([]);
      expect(effort([action()], health("behind"))[0]?.health).toBe("behind");
      expect(effort([action()], health("behind", "another-project"))).toEqual([]);
    });

    it("reads only open one-off work with something left and a date", () => {
      const read = (overrides: Partial<EffortAction>) => effort([action(overrides)], health("at_risk")).length;
      expect(read({})).toBe(1);
      expect(read({ status: "inbox" })).toBe(1);
      for (const status of ["done", "cancelled", "archived", "blocked", "waiting"])
        expect(read({ status }), status).toBe(0);
      expect(read({ remainingMinutes: 0 })).toBe(0);
      // A cycle resets a cadence or recurring action's time, and the forecast does not price either.
      expect(read({ schedulingMode: "cadence" })).toBe(0);
      expect(read({ schedulingMode: "recurring" })).toBe(0);
      // Nothing says when it was set: unknown, never aged, so a request from before the column flags nothing.
      expect(read({ remainingSetAt: undefined })).toBe(0);
      expect(read({ remainingSetAt: "not a date" })).toBe(0);
    });

    it("lists behind projects first, then the oldest estimate", () => {
      const list = effort(
        [
          action({ id: "a-recent", projectId: "project-1", remainingSetAt: ago(15 * DAY) }),
          action({ id: "b-old", projectId: "project-1", remainingSetAt: ago(40 * DAY) }),
          action({ id: "c-behind", projectId: "project-2", remainingSetAt: ago(20 * DAY) })
        ],
        new Map([
          ["project-1", "at_risk"],
          ["project-2", "behind"]
        ])
      );
      expect(list.map((item) => item.actionId)).toEqual(["c-behind", "b-old", "a-recent"]);
    });

    it("never ends a plan's validity", () => {
      const result = resolveFreshness(state({ actions: [action({ remainingSetAt: ago(10 * DAY) })] }), now, {
        projectHealth: health("at_risk")
      });
      expect(result.effort[0]).toMatchObject({ stale: false, staleAt: ahead(4 * DAY) });
      // The soonest fact to age is still one of the daily ones, with or without the estimate.
      expect(nextStaleAt(result, now)).toEqual(nextStaleAt(resolveFreshness(state(), now), now));
      expect(nextStaleAt(result, now)!.getTime()).toBeLessThan(now.getTime() + DAY);
    });
  });
});

describe("the effort helpers", () => {
  it("reads when an estimate was set, and leaves a missing or unreadable date alone", () => {
    expect(effortAge(undefined, now)).toBeUndefined();
    expect(effortAge("soon", now)).toBeUndefined();
    expect(effortAge(new Date(now.getTime() - 15 * 24 * HOUR), now)).toMatchObject({ stale: true });
    expect(effortAge(ago(24 * HOUR), now)).toMatchObject({ stale: false, staleAt: ahead(13 * 24 * HOUR) });
  });

  it("counts behind and at risk, and nothing else, as at risk", () => {
    expect(["behind", "at_risk", "on_track", "ahead", "unknown", undefined].map(atRiskHealth)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false
    ]);
  });

  it("reads each project's health from the stored schedule, and nothing from a plan that has none", () => {
    expect(
      projectHealthFromSchedule({
        forecasts: [
          { projectId: "p1", health: "at_risk" },
          { projectId: "p2" },
          null,
          { projectId: 3, health: "behind" }
        ]
      })
    ).toEqual(new Map([["p1", "at_risk"]]));
    for (const none of [undefined, null, {}, { forecasts: "x" }, "x"])
      expect(projectHealthFromSchedule(none).size).toBe(0);
  });
});

describe("nextStaleAt", () => {
  it("is the soonest moment a still-good fact goes stale", () => {
    const result = resolveFreshness(
      state({
        settings: { maxAwakeHours: 20, lastWokeAt: ago(HOUR) },
        currentSituation: { locationId: "home", locationSetAt: ago(7 * HOUR), energySetAt: ago(HOUR) }
      }),
      now
    );
    // Location goes just past eight hours (an hour away); energy at eight hours from an hour ago (seven away).
    expect(nextStaleAt(result, now)?.toISOString()).toBe(ahead(HOUR + 1));
  });

  it("reads each fact as stale at its own staleAt, so a plan calculated then neither uses it nor waits on it", () => {
    const wake = (20 + WAKE_STALE_GRACE_HOURS) * HOUR;
    const energy = ENERGY_STALE_HOURS * HOUR;
    const place = DEFAULT_LOCATION_STALE_AFTER_MINUTES * MINUTE + 1;
    const grace = SESSION_STALE_MIN_GRACE_MINUTES * MINUTE;
    const result = resolveFreshness(
      state({
        settings: { maxAwakeHours: 20, lastWokeAt: ago(wake) },
        activeSession: session({ plannedMinutes: 45, plannedEndAt: ago(grace) }),
        currentSituation: { locationId: "home", locationSetAt: ago(place), energySetAt: ago(energy) }
      }),
      now
    );
    for (const name of ["wake", "session", "energy", "location"] as const) {
      expect(result[name].staleAt, name).toBe(now.toISOString());
      expect(result[name].stale, name).toBe(true);
    }
    expect(nextStaleAt(result, now)).toBeUndefined();
  });

  it("ignores facts that are stale already, and is absent when nothing is left to age", () => {
    const result = resolveFreshness(
      state({
        settings: { maxAwakeHours: 20, lastWokeAt: ago(30 * HOUR) },
        currentSituation: { locationId: null }
      }),
      now
    );
    expect(nextStaleAt(result, now)).toBeUndefined();
  });
});

describe("the words", () => {
  it("says a span the way a person would", () => {
    expect(spanLabel(45 * MINUTE)).toBe("45 min");
    expect(spanLabel(90 * MINUTE)).toBe("1.5 h");
    expect(spanLabel(19 * HOUR)).toBe("19 h");
    expect(spanLabel(21 * 24 * HOUR)).toBe("21 days");
  });

  it("asks when a running session stopped, with how long it has run and was meant to", () => {
    expect(sessionEndQuestion(session(), now)).toBe("Running 19 h, planned 45 min. When did it stop?");
  });

  it("asks differently for a paused session and one waiting on feedback", () => {
    const paused = session({ status: "paused", pausedAt: ago(5 * HOUR) });
    // Its end is the pause, already recorded, so the question is only whether it is over.
    expect(sessionEndQuestion(paused, now)).toBe("Paused 5 h ago. Finish it?");
    const feedback = session({ status: "feedback", plannedEndAt: ago(6 * HOUR) });
    expect(sessionEndQuestion(feedback, now)).toBe(
      "Waiting for your feedback since its planned end, 6 h ago. When did it stop?"
    );
  });

  it("names the session by its title, else its action, else plainly", () => {
    expect(openSessionTitle(session({ targetTitle: "Lab 7" }), [{ id: "action-1", title: "Other" }])).toBe("Lab 7");
    expect(openSessionTitle(session(), [{ id: "action-1", title: "Write notes" }])).toBe("Write notes");
    expect(openSessionTitle(session(), [])).toBe("Open session");
  });
});
