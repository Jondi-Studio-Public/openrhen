import { commitmentRepeatFallsOn, type PlanForecastResponse } from "@openrhen/contracts";
import type { PortalState, StoredCommitment, StoredCommitmentRecurrenceRule } from "@/state/portal-state";
import type { ClientAllocation, ClientRecommendation, ClientSlot } from "@/state/portal-provider";
import { buildDayPlan, type DayPlan, type DayPlanState } from "@/features/today/day-plan";
import { nextDayKey, zonedWallTimeOnDay } from "@/features/today/local-datetime";
import { localDayKey } from "@/features/today/today-view";

/**
 * The week as seven single days, each built by the same `buildDayPlan` that draws today. There is no
 * second layout engine here — a week is what a day is, seven times, plus the one thing a day alone
 * can't show: a recurring commitment the server hasn't materialized yet because it is still further
 * out than the forecast job bothers to look.
 */

export type WeekPlanState = DayPlanState & Pick<PortalState, "commitmentRecurrenceRules">;

export interface WeekPlanInput {
  state: WeekPlanState;
  slots: ClientSlot[];
  allocations: ClientAllocation[];
  /** The engine's forward-simulated day; passed to every day, `buildDayPlan` clips it per day. */
  engineDayPlan?: PlanForecastResponse["dayPlan"] | null;
  /** Answers about this minute; given only to the day `now` falls on, never repeated onto the rest. */
  currentDirective: PlanForecastResponse["currentDirective"] | null;
  recommendation: ClientRecommendation | null;
  upcomingDirectives: PlanForecastResponse["upcomingDirectives"];
  now: Date;
  timezone: string;
  anchorDayKey: string;
}

export interface WeekPlanDay {
  dayKey: string;
  plan: DayPlan;
}

export interface WeekPlan {
  anchorDayKey: string;
  days: WeekPlanDay[];
}

/**
 * Seven consecutive local day keys starting at the anchor. The window is rolling, not calendar-week
 * snapped: paging by seven days keeps "today" as day one of whichever week is on screen rather than
 * jumping back to a Monday that may already be half gone.
 */
export function weekDayKeys(anchorDayKey: string): string[] {
  return Array.from({ length: 7 }, (_, index) => nextDayKey(anchorDayKey, index));
}

/**
 * Recurring commitments the server hasn't materialized yet, synthesized so the week doesn't quietly
 * lose a series that runs past the forecast job's horizon. Each is a real `StoredCommitment` shape —
 * tentative, so it draws with the same styling a not-yet-confirmed occurrence already gets — never a
 * duplicate of a day the server has materialized for real, matched by rule and local date rather than
 * by time, so an occurrence someone already moved or cancelled is never redrawn on top of.
 */
export function projectedRuleCommitments(
  rules: StoredCommitmentRecurrenceRule[],
  dayKeys: string[],
  existingCommitments: StoredCommitment[]
): StoredCommitment[] {
  const materialized = new Set(
    existingCommitments
      .filter((commitment) => commitment.recurrenceRuleId && commitment.localDate)
      .map((commitment) => `${commitment.recurrenceRuleId}:${commitment.localDate}`)
  );
  const projected: StoredCommitment[] = [];
  for (const rule of rules) {
    if (rule.status !== "active") continue;
    for (const dayKey of dayKeys) {
      if (dayKey < rule.startDate) continue;
      if (rule.endDate && dayKey > rule.endDate) continue;
      if (!commitmentRepeatFallsOn(rule.repeat, rule.startDate, dayKey)) continue;
      if (materialized.has(`${rule.id}:${dayKey}`)) continue;
      projected.push({
        id: `projected:${rule.id}:${dayKey}`,
        title: rule.title,
        startsAt: zonedWallTimeOnDay(dayKey, rule.localStartTime, rule.timezone).toISOString(),
        endsAt: zonedWallTimeOnDay(dayKey, rule.localEndTime, rule.timezone).toISOString(),
        status: "tentative",
        setupBeforeMinutes: rule.setupBeforeMinutes,
        transitionAfterMinutes: rule.transitionAfterMinutes,
        recurrenceRuleId: rule.id,
        localDate: dayKey,
        ...(rule.location ? { location: rule.location } : {}),
        ...(rule.locationId ? { locationId: rule.locationId } : {}),
        ...(rule.projectId ? { projectId: rule.projectId } : {}),
        // Presence travels with the projection for the same reason the rest of this does: a series
        // that only anchors you somewhere must not draw as an hour taken once it passes the horizon.
        ...(rule.presence ? { presence: rule.presence } : {}),
        // The real materialization job copies these from the rule too (falling back to "inherit"),
        // so a projection matches what actually lands in the database once the horizon reaches it.
        ...(rule.routineSource ? { routineSource: rule.routineSource } : {}),
        ...(rule.routinePresetId ? { routinePresetId: rule.routinePresetId } : {})
      });
    }
  }
  return projected;
}

/**
 * Seven `buildDayPlan` calls sharing one state, one engine result, one clock. Projected recurring
 * commitments are folded into `commitments` once, up front, by a shallow state override — every
 * day's plan sees them as facts the same way it sees a materialized commitment, so nothing downstream
 * needs to know the two apart except by the `tentative` flag they already carry either way.
 *
 * The engine's answers about *this minute* — the current directive, the recommendation, what's next
 * in ranking — belong to the day `now` falls on and nowhere else; every other day gets `buildDayPlan`
 * the same way `today/page.tsx` already builds tomorrow, with those three inputs withheld rather than
 * repeated onto a day that hasn't started.
 */
export function buildWeekPlan(input: WeekPlanInput): WeekPlan {
  const {
    state,
    slots,
    allocations,
    engineDayPlan,
    currentDirective,
    recommendation,
    upcomingDirectives,
    now,
    timezone,
    anchorDayKey
  } = input;
  const dayKeys = weekDayKeys(anchorDayKey);
  const projected = projectedRuleCommitments(state.commitmentRecurrenceRules, dayKeys, state.commitments);
  const projectedState: WeekPlanState = { ...state, commitments: [...state.commitments, ...projected] };
  const nowDayKey = localDayKey(now, timezone);
  const days = dayKeys.map((dayKey) => {
    const plan = buildDayPlan({
      state: projectedState,
      slots,
      allocations,
      recommendation: dayKey === nowDayKey ? recommendation : null,
      currentDirective: dayKey === nowDayKey ? currentDirective : null,
      upcomingDirectives: dayKey === nowDayKey ? upcomingDirectives : [],
      dayPlan: engineDayPlan,
      dayKey,
      now,
      timezone
    });
    // Waits are out of scope for the week view,
    // even for the column that is today: the strip belongs to the day view alone. Markers (leave-by,
    // start-by) are still wanted here, so only `waits` is stripped, never `items`.
    return { dayKey, plan: { ...plan, waits: [] } };
  });
  return { anchorDayKey, days };
}
