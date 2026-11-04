import { describe, expect, it } from "vitest";
import type { CommitmentTimelineWire, DayPlan, JourneyCell, JourneySummary, TransportMode } from "@openrhen/contracts";
import { TRAVEL_LOOKUP_RESERVE } from "@/server/travel/travel-spend";
import { buildTravelLookupPlan, deriveTodayLegOrigins, type BuildTravelLookupPlanInput } from "./lookup-plan";

const TIMEZONE = "UTC";

const stats = (count: number, median = 20, p80 = 24, p95 = 28) => ({ count, median, p80, p95 });
const emptyStats = stats(0, 0, 0, 0);

function cell(
  overrides: Partial<JourneyCell> & Pick<JourneyCell, "fromLocationId" | "toLocationId" | "mode">
): JourneyCell {
  return { dayType: null, band: null, pooled: emptyStats, own: emptyStats, ...overrides };
}

function edge(fromLocationId: string, toLocationId: string, mode: TransportMode = "car") {
  return {
    fromLocationId,
    toLocationId,
    mode,
    minutes: 20,
    typicalMinutes: 20,
    source: "typical" as const,
    sampleCount: 0
  };
}

let timelineCounter = 0;
function timeline(overrides: Partial<CommitmentTimelineWire> = {}): CommitmentTimelineWire {
  timelineCounter += 1;
  const startsAt = overrides.startsAt ?? "2026-09-28T09:00:00.000Z";
  return {
    id: `commitment-${timelineCounter}`,
    setupStartsAt: startsAt,
    arriveBy: startsAt,
    startsAt,
    endsAt: startsAt,
    effectiveEndsAt: startsAt,
    freeAt: startsAt,
    protectedUntil: startsAt,
    overtime: false,
    latenessMatters: true,
    ...overrides
  };
}

function emptyDayPlan(overrides: Partial<DayPlan> = {}): DayPlan {
  return {
    through: "2026-09-28T23:59:59.000Z",
    mode: "policy_replay",
    blocks: [],
    truncated: false,
    displaced: [],
    locations: [],
    ...overrides
  };
}

function baseInput(overrides: Partial<BuildTravelLookupPlanInput> = {}): BuildTravelLookupPlanInput {
  return {
    now: new Date("2026-09-28T08:00:00.000Z"), // Monday
    timeZone: TIMEZONE,
    budgetRemaining: 100,
    commitmentTimelines: [],
    dayPlan: emptyDayPlan(),
    journeySummary: { cells: [], latest: [] } satisfies JourneySummary,
    todayLegOrigins: new Map(),
    ...overrides
  };
}

describe("buildTravelLookupPlan — next leg live (step 1)", () => {
  it("asks once within ±5 minutes of 60 minutes before leave-by", () => {
    const leaveBy = "2026-09-28T09:00:00.000Z"; // now + 60 minutes exactly
    const plan = buildTravelLookupPlan(
      baseInput({
        now: new Date("2026-09-28T08:00:00.000Z"),
        commitmentTimelines: [timeline({ leaveBy, journeyBefore: edge("home", "work") })]
      })
    );
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ step: "next_leg_live", originLocationId: "home", allowReserve: true });
  });

  it("does not ask again once a Google sample already covers that window", () => {
    const leaveBy = "2026-09-28T09:00:00.000Z";
    const plan = buildTravelLookupPlan(
      baseInput({
        now: new Date("2026-09-28T08:00:00.000Z"),
        commitmentTimelines: [timeline({ leaveBy, journeyBefore: edge("home", "work") })],
        journeySummary: {
          cells: [],
          latest: [
            {
              fromLocationId: "home",
              toLocationId: "work",
              mode: "car",
              minutes: 22,
              departedAt: "2026-09-28T09:00:00.000Z",
              observedAt: "2026-09-28T08:00:00.000Z" // inside the ±5 window around 08:00
            }
          ]
        }
      })
    );
    expect(plan).toHaveLength(0);
  });

  it("is not due outside the ±5 minute window", () => {
    const leaveBy = "2026-09-28T09:20:00.000Z"; // 80 minutes ahead: neither window applies
    const plan = buildTravelLookupPlan(
      baseInput({
        now: new Date("2026-09-28T08:00:00.000Z"),
        commitmentTimelines: [timeline({ leaveBy, journeyBefore: edge("home", "work") })]
      })
    );
    expect(plan).toHaveLength(0);
  });
});

describe("buildTravelLookupPlan — today's legs (step 2)", () => {
  it("asks for each distinct remaining pair and mode on today's day plan", () => {
    const dayPlan = emptyDayPlan({
      blocks: [
        {
          startsAt: "2026-09-28T10:00:00.000Z",
          endsAt: "2026-09-28T10:30:00.000Z",
          kind: "travel",
          targetId: null,
          title: "Drive to the shops",
          toLocationId: "shops",
          mode: "car",
          focusedMinutes: 0,
          wallClockMinutes: 30,
          reason: "errand",
          confidence: "projected"
        }
      ]
    });
    const plan = buildTravelLookupPlan(baseInput({ dayPlan, todayLegOrigins: deriveTodayLegOrigins(dayPlan) }));
    // No origin band covers the block, so deriveTodayLegOrigins finds nothing and the leg is skipped.
    expect(plan).toHaveLength(0);

    const withOrigin = emptyDayPlan({
      blocks: dayPlan.blocks,
      locations: [
        { startsAt: "2026-09-28T00:00:00.000Z", endsAt: "2026-09-28T10:00:00.000Z", locationId: "home", label: "Home" }
      ]
    });
    const planWithOrigin = buildTravelLookupPlan(
      baseInput({ dayPlan: withOrigin, todayLegOrigins: deriveTodayLegOrigins(withOrigin) })
    );
    expect(planWithOrigin).toHaveLength(1);
    expect(planWithOrigin[0]).toMatchObject({
      step: "today",
      originLocationId: "home",
      destinationLocationIds: ["shops"],
      allowReserve: false
    });
  });

  it("skips a pair already measured today for that same departure", () => {
    const dayPlan = emptyDayPlan({
      blocks: [
        {
          startsAt: "2026-09-28T10:00:00.000Z",
          endsAt: "2026-09-28T10:30:00.000Z",
          kind: "travel",
          targetId: null,
          title: "Drive to the shops",
          toLocationId: "shops",
          mode: "car",
          focusedMinutes: 0,
          wallClockMinutes: 30,
          reason: "errand",
          confidence: "projected"
        }
      ],
      locations: [
        { startsAt: "2026-09-28T00:00:00.000Z", endsAt: "2026-09-28T10:00:00.000Z", locationId: "home", label: "Home" }
      ]
    });
    const plan = buildTravelLookupPlan(
      baseInput({
        dayPlan,
        todayLegOrigins: deriveTodayLegOrigins(dayPlan),
        journeySummary: {
          cells: [],
          latest: [
            {
              fromLocationId: "home",
              toLocationId: "shops",
              mode: "car",
              minutes: 15,
              departedAt: "2026-09-28T10:00:00.000Z",
              observedAt: "2026-09-28T08:00:00.000Z"
            }
          ]
        }
      })
    );
    expect(plan).toHaveLength(0);
  });
});

describe("buildTravelLookupPlan — tomorrow's first leg (step 3)", () => {
  it("is due only from 18:00 local onward", () => {
    const tomorrow = timeline({ leaveBy: "2026-09-29T09:00:00.000Z", journeyBefore: edge("home", "work") });
    const before = buildTravelLookupPlan(
      baseInput({ now: new Date("2026-09-28T17:00:00.000Z"), commitmentTimelines: [tomorrow] })
    );
    expect(before).toHaveLength(0);
    const after = buildTravelLookupPlan(
      baseInput({ now: new Date("2026-09-28T18:30:00.000Z"), commitmentTimelines: [tomorrow] })
    );
    expect(after.some((g) => g.step === "tomorrow_first")).toBe(true);
  });
});

describe("buildTravelLookupPlan — the reserve before and after 21:00", () => {
  const dayPlan = emptyDayPlan({
    blocks: [
      {
        startsAt: "2026-09-28T21:30:00.000Z",
        endsAt: "2026-09-28T22:00:00.000Z",
        kind: "travel",
        targetId: null,
        title: "Drive to the shops",
        toLocationId: "shops",
        mode: "car",
        focusedMinutes: 0,
        wallClockMinutes: 30,
        reason: "errand",
        confidence: "projected"
      }
    ],
    locations: [
      { startsAt: "2026-09-28T00:00:00.000Z", endsAt: "2026-09-28T21:30:00.000Z", locationId: "home", label: "Home" }
    ]
  });

  it("keeps the last 15 elements before 21:00 local, so a non-live step is not proposed once only the reserve is left", () => {
    const plan = buildTravelLookupPlan(
      baseInput({
        now: new Date("2026-09-28T20:00:00.000Z"),
        budgetRemaining: TRAVEL_LOOKUP_RESERVE,
        dayPlan,
        todayLegOrigins: deriveTodayLegOrigins(dayPlan)
      })
    );
    expect(plan).toHaveLength(0);
  });

  it("spends the reserve for a non-live step once local time reaches 21:00", () => {
    const plan = buildTravelLookupPlan(
      baseInput({
        now: new Date("2026-09-28T21:05:00.000Z"),
        budgetRemaining: TRAVEL_LOOKUP_RESERVE,
        dayPlan,
        todayLegOrigins: deriveTodayLegOrigins(dayPlan)
      })
    );
    expect(plan).toHaveLength(1);
  });
});

describe("buildTravelLookupPlan — top-up (step 5)", () => {
  function weekPlan(now: Date) {
    return baseInput({
      now,
      commitmentTimelines: [
        timeline({
          startsAt: "2026-09-29T09:00:00.000Z",
          leaveBy: "2026-09-29T08:30:00.000Z",
          journeyBefore: edge("home", "gym")
        }),
        timeline({
          startsAt: "2026-09-30T09:00:00.000Z",
          leaveBy: "2026-09-30T08:30:00.000Z",
          journeyBefore: edge("home", "dentist")
        })
      ]
    });
  }

  it("fills fewest-Google-samples cells first, soonest cell on a tie", () => {
    const now = new Date("2026-09-28T22:00:00.000Z"); // the first top-up tick
    const input = weekPlan(now);
    // Both legs depart 08:30 on a weekday, so they share the same band (weekday, band 17).
    input.journeySummary = {
      cells: [
        cell({
          fromLocationId: "home",
          toLocationId: "gym",
          mode: "car",
          dayType: "weekday",
          band: 17,
          pooled: stats(5),
          own: emptyStats
        }),
        cell({
          fromLocationId: "home",
          toLocationId: "dentist",
          mode: "car",
          dayType: "weekday",
          band: 17,
          pooled: stats(1),
          own: emptyStats
        })
      ],
      latest: []
    };
    const plan = buildTravelLookupPlan(input);
    const topUp = plan.filter((g) => g.step === "top_up");
    // The two destinations share an origin, mode and next occurrence, so they land in one group; the
    // fewer-Google-samples cell (dentist) is ordered first within it.
    expect(topUp).toHaveLength(1);
    expect(topUp[0]?.destinationLocationIds).toEqual(["dentist", "gym"]);
  });

  it("never tops up a bike or walk pair once any Google sample exists for it", () => {
    const now = new Date("2026-09-28T22:00:00.000Z");
    const input = weekPlan(now);
    input.commitmentTimelines = [
      timeline({
        startsAt: "2026-09-29T09:00:00.000Z",
        leaveBy: "2026-09-29T08:30:00.000Z",
        journeyBefore: edge("home", "gym", "bike")
      })
    ];
    input.journeySummary = {
      cells: [cell({ fromLocationId: "home", toLocationId: "gym", mode: "bike", pooled: stats(1), own: emptyStats })],
      latest: []
    };
    const plan = buildTravelLookupPlan(input);
    expect(plan.filter((g) => g.step === "top_up")).toHaveLength(0);
  });

  it("holds back 2 elements at the first top-up tick (22:00) but spends the rest at the final one (23:45)", () => {
    // Three days out, so tomorrow's-first-leg (step 3) never competes with this step's own budget.
    const farCommitment = timeline({
      startsAt: "2026-10-01T09:00:00.000Z",
      leaveBy: "2026-10-01T08:30:00.000Z",
      journeyBefore: edge("home", "gym")
    });

    const input22 = baseInput({
      now: new Date("2026-09-28T22:00:00.000Z"),
      budgetRemaining: 1,
      commitmentTimelines: [farCommitment]
    });
    expect(buildTravelLookupPlan(input22).filter((g) => g.step === "top_up")).toHaveLength(0);

    const input2345 = baseInput({
      now: new Date("2026-09-28T23:45:00.000Z"),
      budgetRemaining: 1,
      commitmentTimelines: [farCommitment]
    });
    expect(buildTravelLookupPlan(input2345).filter((g) => g.step === "top_up")).toHaveLength(1);
  });

  it("is not due outside the 22:00/23:45 windows", () => {
    const input = weekPlan(new Date("2026-09-28T19:00:00.000Z"));
    expect(buildTravelLookupPlan(input).filter((g) => g.step === "top_up")).toHaveLength(0);
  });
});

describe("buildTravelLookupPlan — grouping", () => {
  it("batches destinations sharing an origin, mode and departure, up to 25", () => {
    const now = new Date("2026-09-28T22:00:00.000Z");
    const timelines = Array.from({ length: 30 }, (_, i) =>
      timeline({
        startsAt: "2026-09-29T09:00:00.000Z",
        leaveBy: "2026-09-29T08:30:00.000Z",
        journeyBefore: edge("home", `place-${i}`)
      })
    );
    const input = baseInput({ now, commitmentTimelines: timelines });
    const plan = buildTravelLookupPlan(input);
    const topUp = plan.filter((g) => g.step === "top_up");
    expect(topUp.every((g) => g.destinationLocationIds.length <= 25)).toBe(true);
    const total = topUp.reduce((sum, g) => sum + g.destinationLocationIds.length, 0);
    expect(total).toBe(30);
  });
});

describe("buildTravelLookupPlan — exhaustion", () => {
  it("asks for nothing once the day's budget is spent", () => {
    const plan = buildTravelLookupPlan(
      baseInput({
        budgetRemaining: 0,
        commitmentTimelines: [timeline({ leaveBy: "2026-09-28T09:00:00.000Z", journeyBefore: edge("home", "work") })]
      })
    );
    expect(plan).toHaveLength(0);
  });
});

describe("deriveTodayLegOrigins", () => {
  it("reads the location band active immediately before a travel block", () => {
    const dayPlan = emptyDayPlan({
      blocks: [
        {
          startsAt: "2026-09-28T10:00:00.000Z",
          endsAt: "2026-09-28T10:30:00.000Z",
          kind: "travel",
          targetId: null,
          title: "Drive",
          toLocationId: "shops",
          mode: "car",
          focusedMinutes: 0,
          wallClockMinutes: 30,
          reason: "errand",
          confidence: "projected"
        }
      ],
      locations: [
        { startsAt: "2026-09-28T00:00:00.000Z", endsAt: "2026-09-28T10:00:00.000Z", locationId: "home", label: "Home" }
      ]
    });
    expect(deriveTodayLegOrigins(dayPlan).get("2026-09-28T10:00:00.000Z")).toBe("home");
  });

  it("leaves a block out when no band covers it", () => {
    const dayPlan = emptyDayPlan({
      blocks: [
        {
          startsAt: "2026-09-28T10:00:00.000Z",
          endsAt: "2026-09-28T10:30:00.000Z",
          kind: "travel",
          targetId: null,
          title: "Drive",
          toLocationId: "shops",
          mode: "car",
          focusedMinutes: 0,
          wallClockMinutes: 30,
          reason: "errand",
          confidence: "projected"
        }
      ]
    });
    expect(deriveTodayLegOrigins(dayPlan).size).toBe(0);
  });
});
