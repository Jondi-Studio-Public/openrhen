import { describe, expect, it } from "vitest";
import type { ConditionDefinition, CurrentSituation, JourneySummary } from "@openrhen/contracts";
import { buildJourneyIndex } from "@openrhen/contracts";
import {
  ARRIVAL_MARGIN_MINUTES,
  chooseAfterAnchorByUsableMinutes,
  projectSituation,
  type FixedCommitment,
  type ProjectSituationInput,
  type SituationSegment
} from "../../src/index.js";

/**
 * The projection is the plan's only knowledge of where you will be. These tests hold each rule to
 * its statement: legs are additive around a commitment, transit is nowhere, the after-anchor choice
 * is the usable-minutes comparison, sleep is at home, and nothing depends on input order.
 *
 * Every leg now carries the journey store's padding:
 * with no samples at all, allowing is the stored (or estimated) figure plus `max(3, 0.15 × typical)`,
 * rounded up. `padded` is that same arithmetic, so a test states its intent (20 stored minutes to
 * campus) once and the padded figure follows rather than being hand-computed and repeated.
 */
const padded = (minutes: number) => Math.ceil(minutes + Math.max(3, 0.15 * minutes));

const MINUTE = 60_000;
/** 09:00 UTC. */
const now = new Date("2026-08-19T09:00:00.000Z");
const at = (minutes: number) => new Date(now.getTime() + minutes * MINUTE);
const through = at(14 * 60);

const location = (id: string, extra: Partial<ConditionDefinition> = {}): ConditionDefinition => ({
  id,
  name: id,
  kind: "location",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  channels: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  ...extra
});
const definitions = [
  location("home", { latitude: -36.08, longitude: 146.91 }),
  location("campus", { travelMinutes: 20, latitude: -36.09, longitude: 146.95 }),
  location("shops", { travelMinutes: 5, latitude: -36.085, longitude: 146.92 }),
  location("gym", { latitude: -36.1, longitude: 146.9 })
];
const situation = (extra: Partial<CurrentSituation> = {}): CurrentSituation => ({
  locationId: "home",
  locationSetAt: now.toISOString(),
  overrides: { printer: "unavailable" },
  carrying: { laptop: true },
  transportModes: ["car", "bike", "walk"],
  travel: {},
  travelOff: false,
  ...extra
});
const commitment = (
  id: string,
  startMinutes: number,
  endMinutes: number,
  extra: Partial<FixedCommitment> = {}
): FixedCommitment => ({ id, startsAt: at(startMinutes), endsAt: at(endMinutes), ...extra });
const project = (
  overrides: Omit<Partial<ProjectSituationInput>, "homeLocationId" | "journeys"> & {
    homeLocationId?: string | undefined;
    journeys?: JourneySummary;
  } = {},
  seed: Partial<CurrentSituation> = {}
) => {
  const { homeLocationId, journeys, ...rest } = { homeLocationId: "home", ...overrides };
  return projectSituation({
    from: {
      at: now,
      situation: situation(seed),
      resolvedLocationId: seed.locationId === undefined ? "home" : seed.locationId
    },
    ...(homeLocationId === undefined ? {} : { homeLocationId }),
    definitions,
    commitments: [],
    sleepPlans: [],
    through,
    timeZone: "UTC",
    ...(journeys ? { journeys: buildJourneyIndex(journeys) } : {}),
    ...rest
  });
};
const summarise = (segments: SituationSegment[]) =>
  segments.map((segment) => [
    (segment.startsAt.getTime() - now.getTime()) / MINUTE,
    (segment.endsAt.getTime() - now.getTime()) / MINUTE,
    segment.inTransitTo ? `→${segment.inTransitTo}` : segment.locationId
  ]);

describe("projectSituation", () => {
  it("stays put all day when nothing is anchored", () => {
    const day = project();
    expect(summarise(day.segments)).toEqual([[0, 14 * 60, "home"]]);
    expect(day.legs).toEqual([]);
    expect(day.at(at(300))).toMatchObject({ locationId: "home", overrides: { printer: "unavailable" } });
  });

  it("puts travel before the arrival margin, transit nowhere, then the place, then home again", () => {
    // Campus 11:00–12:00, transition 10, fallback 20 min (padded). Depart before arrival margin,
    // arrive, free 12:10, then straight home (the only later anchor is sleep at home).
    const toCampus = padded(20);
    const day = project({
      commitments: [commitment("c1", 120, 180, { locationId: "campus", transitionAfterMinutes: 10 })],
      sleepPlans: [{ id: "s1", plannedStartAt: at(13 * 60), plannedWakeAt: at(21 * 60) }]
    });
    expect(summarise(day.segments)).toEqual([
      [0, 120 - ARRIVAL_MARGIN_MINUTES - toCampus, "home"],
      [120 - ARRIVAL_MARGIN_MINUTES - toCampus, 120 - ARRIVAL_MARGIN_MINUTES, "→campus"],
      [120 - ARRIVAL_MARGIN_MINUTES, 190, "campus"],
      [190, 190 + toCampus, "→home"],
      [190 + toCampus, 14 * 60, "home"]
    ]);
    expect(day.legs.map((leg) => [leg.fromLocationId, leg.toLocationId, leg.minutes, leg.source, leg.reason])).toEqual([
      ["home", "campus", toCampus, "fallback", "commitment"],
      ["campus", "home", toCampus, "assumed", "return_home"]
    ]);
    const inTransit = day.at(at(110));
    expect(inTransit.locationId).toBeNull();
    expect(inTransit.inTransitTo).toBe("campus");
    // Overrides are momentary and gone once you have moved; what you carry is not.
    expect(day.at(at(150))).toMatchObject({ locationId: "campus", overrides: {}, carrying: { laptop: true } });
    expect(day.at(at(150)).inTransitTo).toBeUndefined();
  });

  it("uses a supplied arrival margin instead of the default", () => {
    // Same fixture as the previous test, but with a 10-minute margin instead of the 2-minute default —
    // the arrival phase widens and every later segment shifts by the same 8 minutes.
    const toCampus = padded(20);
    const day = project({
      commitments: [commitment("c1", 120, 180, { locationId: "campus", transitionAfterMinutes: 10 })],
      sleepPlans: [{ id: "s1", plannedStartAt: at(13 * 60), plannedWakeAt: at(21 * 60) }],
      arrivalMarginMinutes: 10
    });
    expect(summarise(day.segments)).toEqual([
      [0, 120 - 10 - toCampus, "home"],
      [120 - 10 - toCampus, 120 - 10, "→campus"],
      [120 - 10, 190, "campus"],
      [190, 190 + toCampus, "→home"],
      [190 + toCampus, 14 * 60, "home"]
    ]);
  });

  it("prefers a live journey sample from where you are, then the stored fallback, then the estimate", () => {
    // Mode order picks "car" here (the fastest by typical, with nothing else to prefer it by, and the
    // first-listed tie-break), so the live sample is recorded for that same mode.
    const day = project({
      journeys: {
        cells: [],
        latest: [
          {
            fromLocationId: "home",
            toLocationId: "campus",
            mode: "car",
            minutes: 12,
            departedAt: now.toISOString(),
            observedAt: now.toISOString()
          }
        ]
      }
    });
    const live = day.travelBetween("home", "campus")!;
    expect(live.mode).toBe("car");
    expect(live.source).toBe("live");
    expect(live.typicalMinutes).toBe(12);
    // No cell to draw a real spread from: the live figure is padded like any other n=0 figure.
    expect(live.minutes).toBe(padded(12));
    expect(day.travelBetween("home", "shops")).toMatchObject({ minutes: padded(5), source: "fallback" });
    // Between two other places nothing is stored, so coordinates decide: about 4 km, car at 40 km/h + 5.
    const estimated = day.travelBetween("campus", "gym")!;
    expect(estimated.source).toBe("estimated");
    expect(estimated.mode).toBe("car");
    expect(estimated.minutes).toBeGreaterThan(5);
    expect(estimated.minutes).toBeLessThan(25);
    // The way there stands in for the way home: campus's own stored figure, reversed.
    const back = project({}, { locationId: "campus" });
    expect(back.travelBetween("campus", "home")).toMatchObject({ minutes: padded(20), source: "assumed" });
    // A live sample by a mode you no longer have is not one you can use.
    const walking = project(
      {
        journeys: {
          cells: [],
          latest: [
            {
              fromLocationId: "home",
              toLocationId: "campus",
              mode: "car",
              minutes: 12,
              departedAt: now.toISOString(),
              observedAt: now.toISOString()
            }
          ]
        }
      },
      { transportModes: ["walk"] }
    );
    expect(walking.travelBetween("home", "campus")).toMatchObject({ minutes: padded(20), source: "fallback" });
    expect(day.travelBetween("home", "home")).toBeUndefined();
    expect(day.travelBetween(null, "campus")).toBeUndefined();
    expect(day.travelBetween("home", "nowhere")).toBeUndefined();
  });

  it("stays at the shops when the next thing is fifteen minutes away and home is five minutes off", () => {
    // The owner's example: at the shops, gym in 15 minutes, 5-minute drive to it, home 5 minutes
    // away. Staying leaves 10 minutes, going home 5 — neither a session, so you stay and go direct.
    expect(
      chooseAfterAnchorByUsableMinutes({
        atLocationId: "shops",
        homeLocationId: "home",
        nextLocationId: "gym",
        gapMinutes: 15,
        directMinutes: 5,
        toHomeMinutes: 5,
        homeToNextMinutes: 5,
        minSessionMinutes: 15
      })
    ).toBe("stay");
    // The same shape as a whole day: shops 09:30–09:45, gym at 10:00, then home for the night.
    const toShops = padded(5);
    const toGym = padded(5);
    const day = project({
      definitions: [
        ...definitions.filter((definition) => definition.id !== "gym"),
        location("gym", { travelMinutes: 5 })
      ],
      commitments: [
        commitment("shops", 30, 45, { locationId: "shops" }),
        commitment("gym", 60, 120, { locationId: "gym" })
      ]
    });
    expect(summarise(day.segments)).toEqual([
      [0, 30 - ARRIVAL_MARGIN_MINUTES - toShops, "home"],
      [30 - ARRIVAL_MARGIN_MINUTES - toShops, 30 - ARRIVAL_MARGIN_MINUTES, "→shops"],
      [30 - ARRIVAL_MARGIN_MINUTES, 60 - ARRIVAL_MARGIN_MINUTES - toGym, "shops"],
      [60 - ARRIVAL_MARGIN_MINUTES - toGym, 60 - ARRIVAL_MARGIN_MINUTES, "→gym"],
      [60 - ARRIVAL_MARGIN_MINUTES, 14 * 60, "gym"]
    ]);
  });

  it("goes home between anchors when that leaves the larger usable stretch, and home wins a tie", () => {
    // Two hours between campus and the shops, home 20 minutes off and 5 from the shops.
    const rule = chooseAfterAnchorByUsableMinutes;
    expect(
      rule({
        atLocationId: "campus",
        homeLocationId: "home",
        nextLocationId: "shops",
        gapMinutes: 120,
        directMinutes: 15,
        toHomeMinutes: 20,
        homeToNextMinutes: 5,
        minSessionMinutes: 15
      })
    ).toBe("stay");
    expect(
      rule({
        atLocationId: "campus",
        homeLocationId: "home",
        nextLocationId: "shops",
        gapMinutes: 120,
        directMinutes: 25,
        toHomeMinutes: 20,
        homeToNextMinutes: 5,
        minSessionMinutes: 15
      })
    ).toBe("home");
    expect(
      rule({
        atLocationId: "campus",
        homeLocationId: "home",
        nextLocationId: "shops",
        gapMinutes: 120,
        directMinutes: 20,
        toHomeMinutes: 20,
        homeToNextMinutes: 0,
        minSessionMinutes: 15
      })
    ).toBe("home");
    // Only home reaches a session: home.
    expect(
      rule({
        atLocationId: "campus",
        homeLocationId: "home",
        nextLocationId: "shops",
        gapMinutes: 40,
        directMinutes: 30,
        toHomeMinutes: 10,
        homeToNextMinutes: 10,
        minSessionMinutes: 15
      })
    ).toBe("home");
    // No home, or already home: stay.
    expect(
      rule({
        atLocationId: "campus",
        homeLocationId: undefined,
        nextLocationId: "shops",
        gapMinutes: 400,
        directMinutes: 0,
        toHomeMinutes: 0,
        homeToNextMinutes: 0,
        minSessionMinutes: 15
      })
    ).toBe("stay");
    expect(
      rule({
        atLocationId: "home",
        homeLocationId: "home",
        nextLocationId: "shops",
        gapMinutes: 400,
        directMinutes: 5,
        toHomeMinutes: 0,
        homeToNextMinutes: 5,
        minSessionMinutes: 15
      })
    ).toBe("stay");
  });

  it("returns home between two distant anchors and takes a pluggable chooser", () => {
    // Campus 10:00–10:30, then the shops at 13:00.
    const commitments = [
      commitment("a", 60, 90, { locationId: "campus" }),
      commitment("b", 240, 270, { locationId: "shops" })
    ];
    const toHome = padded(20);
    const toShops = padded(5);
    const home = project({ commitments, chooseAfterAnchor: () => "home" });
    expect(summarise(home.segments)).toContainEqual([90, 90 + toHome, "→home"]);
    expect(summarise(home.segments)).toContainEqual([90 + toHome, 240 - ARRIVAL_MARGIN_MINUTES - toShops, "home"]);
    expect(home.legs.map((leg) => leg.reason)).toEqual(["commitment", "return_home", "commitment"]);
    const stay = project({ commitments, chooseAfterAnchor: () => "stay" });
    expect(stay.segments.some((segment) => segment.inTransitTo === "home")).toBe(false);
    expect(stay.legs.map((leg) => [leg.fromLocationId, leg.toLocationId])).toEqual([
      ["home", "campus"],
      ["campus", "shops"]
    ]);
    // Same anchors under the default chooser: direct (shops fallback, 5) beats home first (20 + 5).
    const chosen = project({ commitments });
    expect(chosen.legs.map((leg) => leg.reason)).toEqual(["commitment", "commitment"]);
  });

  it("stays where it was for a commitment with no or an unknown location", () => {
    const day = project({
      commitments: [commitment("c1", 60, 120), commitment("c2", 180, 240, { locationId: "mars" })]
    });
    expect(summarise(day.segments)).toEqual([[0, 14 * 60, "home"]]);
    expect(day.legs).toEqual([]);
  });

  it("sleeps at home, travelling back for it, and not at all without a home", () => {
    const commitments = [commitment("late", 60, 600, { locationId: "campus" })];
    const sleepPlans = [{ id: "s1", plannedStartAt: at(660), plannedWakeAt: at(1140) }];
    const day = project({ commitments, sleepPlans });
    // Free at 19:00, sleep at 20:00 at home: tie on usable minutes → home now, not at the last minute.
    expect(summarise(day.segments)).toContainEqual([600, 600 + padded(20), "→home"]);
    expect(day.legs.at(-1)).toMatchObject({ toLocationId: "home", reason: "return_home" });
    const noHome = project({ commitments, sleepPlans, homeLocationId: undefined });
    expect(noHome.segments.at(-1)).toMatchObject({ locationId: "campus" });
    expect(noHome.legs).toHaveLength(1);
  });

  it("goes home before sleep even when nothing is workable anywhere, unlike a plain commitment-to-commitment gap", () => {
    // Nothing workable at either place: the usable-minutes chooser reads both "stay" and "home" as
    // zero minutes for *any* gap size and ties to "stay" (its own documented default) — exactly the
    // shape that used to leave a commitment stranded away from home all the way to sleep. Sleep is
    // not a trade-off the chooser gets a vote on.
    const workableAt = () => false;
    const commitments = [commitment("late", 60, 600, { locationId: "campus" })];
    const sleepPlans = [{ id: "s1", plannedStartAt: at(660), plannedWakeAt: at(1140) }];
    // Sanity check: the *chooser*, asked directly about this same gap with nothing workable, says stay.
    expect(
      chooseAfterAnchorByUsableMinutes({
        atLocationId: "campus",
        homeLocationId: "home",
        nextLocationId: "home",
        gapMinutes: 60,
        directMinutes: 20,
        toHomeMinutes: 20,
        homeToNextMinutes: 0,
        minSessionMinutes: 15,
        workableHere: false,
        workableAtHome: false
      })
    ).toBe("stay");
    const day = project({ commitments, sleepPlans, workableAt });
    expect(day.legs.at(-1)).toMatchObject({ toLocationId: "home", reason: "return_home" });
    expect(day.segments.at(-1)).toMatchObject({ locationId: "home" });
  });

  it("never attaches a return leg to a commitment that is already at home", () => {
    const commitments = [
      commitment("chores", 30, 60, { locationId: "home" }),
      commitment("late", 120, 600, { locationId: "campus" })
    ];
    const sleepPlans = [{ id: "s1", plannedStartAt: at(660), plannedWakeAt: at(1140) }];
    const day = project({ commitments, sleepPlans });
    // The only "return_home" leg belongs to the away commitment, at the end of the day — none is
    // attached around the at-home commitment, which never left home to begin with.
    expect(day.legs.filter((leg) => leg.reason === "return_home")).toHaveLength(1);
    expect(day.legs.find((leg) => leg.reason === "return_home")).toMatchObject({ fromLocationId: "campus" });
  });

  it("weighs an unestimated onward journey at the assumed figure when choosing to go home", () => {
    // Campus, then a place nothing gives a journey for: the leg there is planned at the assumed 30
    // minutes, so the stay-or-go-home choice must weigh 30 too, not a free trip.
    const seen: Array<{ directMinutes: number; homeToNextMinutes: number }> = [];
    project({
      definitions: [...definitions, location("nowhere")],
      commitments: [
        commitment("a", 60, 90, { locationId: "campus" }),
        commitment("b", 240, 270, { locationId: "nowhere" })
      ],
      chooseAfterAnchor: (input) => {
        seen.push({ directMinutes: input.directMinutes, homeToNextMinutes: input.homeToNextMinutes });
        return "stay";
      }
    });
    expect(seen).toEqual([{ directMinutes: 30, homeToNextMinutes: 30 }]);
  });

  it("weighs no journey at all from home when the next commitment is at home", () => {
    const seen: Array<{ directMinutes: number; homeToNextMinutes: number }> = [];
    project({
      definitions: [...definitions, location("nowhere")],
      commitments: [
        commitment("a", 60, 90, { locationId: "nowhere" }),
        commitment("b", 240, 270, { locationId: "home" })
      ],
      chooseAfterAnchor: (input) => {
        seen.push({ directMinutes: input.directMinutes, homeToNextMinutes: input.homeToNextMinutes });
        return "stay";
      }
    });
    expect(seen.map((item) => item.homeToNextMinutes)).toEqual([0]);
  });

  it("plans the assumed journey, flagged, when no mode of transport is available", () => {
    const day = project({ commitments: [commitment("c1", 60, 120, { locationId: "campus" })] }, { transportModes: [] });
    // Unknown travel is not zero: the commitment still takes the engine's assumed time to reach.
    expect(day.legs).toMatchObject([{ toLocationId: "campus", minutes: 30, source: "default", anchorId: "c1" }]);
    expect([...day.noEstimateAnchorIds]).toEqual(["c1"]);
    expect(day.travelBetween("home", "campus")).toBeUndefined();
    expect(summarise(day.segments)).toEqual([
      [0, 60 - ARRIVAL_MARGIN_MINUTES - 30, "home"],
      [60 - ARRIVAL_MARGIN_MINUTES - 30, 60 - ARRIVAL_MARGIN_MINUTES, "→campus"],
      [60 - ARRIVAL_MARGIN_MINUTES, 14 * 60, "campus"]
    ]);
  });

  it("does not call an unknown origin an assumed one, so there is no place to confirm", () => {
    const base = { commitments: [commitment("c1", 60, 120, { locationId: "campus" })] };
    const unknownSeed = {
      at: now,
      situation: situation({ locationId: null }),
      resolvedLocationId: null,
      assumed: true
    };
    const unknown = projectSituation({
      from: unknownSeed,
      definitions,
      commitments: base.commitments,
      sleepPlans: [],
      through,
      timeZone: "UTC"
    });
    expect(unknown.legs).toHaveLength(1);
    expect(unknown.legs[0]!.originAssumed).toBeUndefined();
    // A known but assumed origin (stale, carried forward) still asks for confirmation.
    const known = projectSituation({
      from: { ...unknownSeed, situation: situation(), resolvedLocationId: "home" },
      definitions,
      commitments: base.commitments,
      sleepPlans: [],
      through,
      timeZone: "UTC"
    });
    expect(known.legs[0]!.originAssumed).toBe(true);
  });

  it("starts from an unknown location and from mid-commitment without inventing a place", () => {
    const unknown = project(
      { commitments: [commitment("c1", 60, 120, { locationId: "campus" })] },
      { locationId: null }
    );
    expect(unknown.segments[0]).toMatchObject({ locationId: null });
    // The destination's own stored figure does not depend on where you start, so it still applies.
    expect(unknown.legs).toMatchObject([{ toLocationId: "campus", source: "fallback", minutes: padded(20) }]);
    expect(unknown.noEstimateAnchorIds.size).toBe(0);
    expect(unknown.at(at(90)).locationId).toBe("campus");
    // Already inside the commitment but asserted at home: you are late, so the leg leaves now.
    const late = project({ commitments: [commitment("c1", -30, 60, { locationId: "campus" })] });
    expect(summarise(late.segments)[0]).toEqual([0, padded(20), "→campus"]);
  });

  it("is deterministic under input order and never reads a clock", () => {
    const commitments = [
      commitment("b", 240, 270, { locationId: "shops" }),
      commitment("a", 60, 90, { locationId: "campus" }),
      commitment("c", 300, 330, { locationId: "gym" })
    ];
    const sleepPlans = [{ id: "s1", plannedStartAt: at(720), plannedWakeAt: at(1200) }];
    const forward = project({ commitments, sleepPlans, definitions });
    const shuffled = project({
      commitments: [...commitments].reverse(),
      sleepPlans,
      definitions: [...definitions].reverse()
    });
    expect(shuffled.segments).toEqual(forward.segments);
    expect(shuffled.legs).toEqual(forward.legs);
    expect(forward.at(at(0)).locationSetAt).toBe(now.toISOString());
    expect(forward.at(at(2000)).locationId).toBe(forward.segments.at(-1)!.locationId);
  });
});
