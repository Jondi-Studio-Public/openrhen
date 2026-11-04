// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { createSeedState } from "@/state/portal-state";
import type { TravelDirective } from "@/features/now/now-model";
import { render, screen } from "@/test/render";
import { TravelPanel } from "@/features/now/components/travel-panel";
import { buildDayPlan, type DayPlanInput } from "./day-plan";

/**
 * The day plan surfaces design note invariant 6: Today's leave-by marker and Now's travel panel
 * must show the same clock time and the same two minute figures for the same commitment.
 *
 * `engine/core/test/system/leave-by-parity.test.ts` proves, on a real `calculatePlanAndForecast`
 * response, that `commitmentTimelines[].leaveBy`/`journeyBefore` and `currentDirective` (the
 * `TravelDirective`) already agree on these fields. The portal package does not depend on
 * `@openrhen/engine-core` (only `engine/service` does), so it cannot run the engine itself; this
 * test instead proves the other half: that neither surface transforms those fields on the way to
 * the screen. Both are built here from one shared set of numbers, run through the real
 * `buildDayPlan` and the real `TravelPanel`, and their rendered output is cross-checked against each
 * other as well as against the source.
 */

const NOW = new Date("2026-08-19T00:00:00.000Z");
const TZ = "UTC";
const DAY = "2026-08-19";

// The one set of facts a real engine response would carry for one commitment's journey, echoed by
// both surfaces (`commitmentTimelines[].leaveBy`/`journeyBefore` for Today, `TravelDirective` for
// Now) with no further arithmetic.
const LEAVE_BY = "2026-08-19T07:14:00.000Z";
const TYPICAL_MINUTES = 40;
const ALLOWING_MINUTES = 46;

const timelineEntry = {
  id: "meeting",
  startsAt: "2026-08-19T08:00:00.000Z",
  setupStartsAt: "2026-08-19T07:14:00.000Z",
  leaveBy: LEAVE_BY,
  arriveBy: "2026-08-19T08:00:00.000Z",
  endsAt: "2026-08-19T09:00:00.000Z",
  effectiveEndsAt: "2026-08-19T09:00:00.000Z",
  freeAt: "2026-08-19T09:00:00.000Z",
  overtime: false,
  latenessMatters: true,
  journeyBefore: {
    fromLocationId: "home",
    toLocationId: "office",
    mode: "car" as const,
    minutes: ALLOWING_MINUTES,
    typicalMinutes: TYPICAL_MINUTES,
    source: "fallback" as const,
    sampleCount: 0
  }
};

function todaysLeaveByItem() {
  const state = createSeedState(NOW);
  const input: DayPlanInput = {
    state: {
      ...state,
      commitments: [
        {
          id: "meeting",
          title: "Meeting",
          startsAt: "2026-08-19T08:00:00.000Z",
          endsAt: "2026-08-19T09:00:00.000Z",
          status: "confirmed",
          setupBeforeMinutes: 0,
          transitionAfterMinutes: 0
        }
      ],
      planning: {
        status: "current",
        result: { derivedState: { commitmentTimelines: [timelineEntry] } }
      } as NonNullable<PortalState["planning"]>
    },
    slots: [],
    allocations: [],
    recommendation: null,
    currentDirective: null,
    upcomingDirectives: [],
    dayKey: DAY,
    now: NOW,
    timezone: TZ
  };
  const plan = buildDayPlan(input);
  const item = plan.items.find((entry) => entry.kind === "leave_by")!;
  expect(item).toBeDefined();
  return item;
}

/**
 * Today's marker draws its clock text with `hour12: false` against whatever timezone `buildDayPlan`
 * is given; Now's panel draws its with `en-AU`'s 12-hour clock against `state.settings.timezone`
 * (`clock` in `now-formatting.ts`). Both are given the same `"UTC"` timezone here, but the display
 * styles still differ (`"07:14"` vs `"7:14 am"`), which is a formatting choice, not the thing
 * invariant 6 is about. This turns either style back into minutes since midnight so the two can be
 * compared on the number they both mean.
 */
function clockTextToMinutes(text: string): number {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(text.trim());
  if (!match) throw new Error(`Not a clock time: ${text}`);
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

function renderNowsTravelPanel() {
  const base = createSeedState(NOW);
  const office = {
    id: "office",
    name: "Office",
    kind: "location" as const,
    status: "active" as const,
    pathways: [],
    portability: "fixed" as const,
    grants: [],
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0,
    channels: []
  };
  const state: PortalState = {
    ...base,
    settings: { ...base.settings, timezone: TZ },
    conditionDefinitions: [office],
    currentSituation: { ...base.currentSituation, locationId: "home", transportModes: ["car"] }
  };
  const directive: TravelDirective = {
    kind: "travel",
    toLocationId: "office",
    title: "Drive to Office",
    leaveBy: LEAVE_BY,
    typicalMinutes: TYPICAL_MINUTES,
    recommendedMinutes: ALLOWING_MINUTES,
    mode: "car",
    source: "fallback"
  };
  render(
    <TravelPanel
      directive={directive}
      destination={office}
      state={state}
      saving={false}
      explanation="Nothing at home outranks the meeting."
      evidence={[]}
      saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
    />
  );
  return screen.getByText(/^Leave by /);
}

describe("invariant 6: the leave-by marker matches Now's travel panel", () => {
  it("shows the same clock time on both surfaces, read straight from the same leaveBy", () => {
    const item = todaysLeaveByItem();
    const panelText = renderNowsTravelPanel().textContent ?? "";

    // Today's marker: "Leave by 07:14 for Meeting" (24-hour, `hour12: false`).
    const todayClockText = /^Leave by (.+?) for /.exec(item.title)?.[1];
    // Now's panel: "Leave by 7:14 am — usually 40 min, allowing 46" (`en-AU`, 12-hour).
    const nowClockText = /^Leave by (.+?) — /.exec(panelText)?.[1];

    expect(todayClockText).toBeDefined();
    expect(nowClockText).toBeDefined();
    // Both are read straight from the same `leaveBy` (07:14 UTC), each in the surface's own display
    // style; converting back to minutes since midnight proves they name the same instant.
    expect(clockTextToMinutes(todayClockText!)).toBe(7 * 60 + 14);
    expect(clockTextToMinutes(nowClockText!)).toBe(7 * 60 + 14);
    expect(clockTextToMinutes(todayClockText!)).toBe(clockTextToMinutes(nowClockText!));
  });

  it("shows the same two minute figures on both surfaces, read straight from journeyBefore/the directive", () => {
    const item = todaysLeaveByItem();
    const panelText = renderNowsTravelPanel().textContent ?? "";

    // Today's caption: "usually 40 min · allowing 46".
    const todayFigures = /usually (\d+) min · allowing (\d+)/.exec(item.subtitle ?? "");
    // Now's panel: "usually 40 min, allowing 46".
    const nowFigures = /usually (\d+) min, allowing (\d+)/.exec(panelText);

    expect(todayFigures).not.toBeNull();
    expect(nowFigures).not.toBeNull();
    expect(todayFigures![1]).toBe(String(TYPICAL_MINUTES));
    expect(todayFigures![2]).toBe(String(ALLOWING_MINUTES));
    // The two surfaces agree with each other, not just with the fixture.
    expect(todayFigures![1]).toBe(nowFigures![1]);
    expect(todayFigures![2]).toBe(nowFigures![2]);
  });
});
