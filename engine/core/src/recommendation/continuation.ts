import { planSchedule, type ScheduleArguments } from "../scheduling/schedule.js";
import { currentCompatibleWindow } from "../scheduling/slots.js";
import type { ContinuationSimulation, PlanningResult, ProjectForecast } from "../model/types.js";

const MINUTE_MS = 60_000;

/**
 * Why keeping going is not offered, in words a person reads at a checkpoint. A zero limit is never
 * stated as "a 0-minute continuation": it means either nothing is left on the work or no time is.
 */
export function continuationRefusal(limit: number, windowMinutes: number, remaining: number, minimum: number): string {
  if (limit <= 0)
    return remaining <= 0
      ? "Nothing is left on this work, so there is nothing to keep going on."
      : "There is no free time left before the next thing that can't move.";
  if (windowMinutes === limit) return `Only ${limit} minutes are free before the next thing that can't move.`;
  return `Only ${limit} minutes are available, and this work needs at least ${minimum} to be worth picking up again.`;
}

/**
 * `baseline`, when given, must be `planSchedule` of these same arguments: the engine passes the plan it
 * has just built rather than planning the same request a second time.
 */
export function simulateContinuation(
  args: ScheduleArguments & { actionId: string; requestedMinutes?: number },
  baseline: PlanningResult = planSchedule(args)
): ContinuationSimulation {
  const action = args.actions.find((item) => item.id === args.actionId);
  const project = action ? args.projects.find((item) => item.id === action.projectId) : undefined;
  if (!action || !project)
    return {
      safe: false,
      recommendedMinutes: 0,
      reason: "The active action or project no longer exists.",
      displacedProjectIds: []
    };
  const window = currentCompatibleWindow({ now: args.now, horizonEnd: args.horizonEnd, action, slots: baseline.slots });
  const limit = Math.min(
    args.requestedMinutes ?? action.maximumSessionMinutes,
    action.maximumSessionMinutes,
    action.remainingMinutes,
    window.minutes
  );
  if (limit < action.minimumSessionMinutes)
    return {
      safe: false,
      recommendedMinutes: 0,
      // Say which of the four bounds actually bit. Blaming the boundary unconditionally was wrong
      // whenever the request itself was the short one — the caller asks for a fixed number of minutes,
      // and a deliverable whose minimum useful session is longer than that was refused with a sentence
      // about protected time that had nothing to do with it.
      reason: continuationRefusal(limit, window.minutes, action.remainingMinutes, action.minimumSessionMinutes),
      displacedProjectIds: []
    };
  const candidates = continuationCandidates(limit, action.minimumSessionMinutes);
  const baselineByProject = new Map(baseline.forecasts.map((forecast) => [forecast.projectId, forecast]));
  // The deadline each project is measured against, as the main ranking reads it: the internal date,
  // falling back to the external one.
  const deadlineOf = (candidate: typeof project, forecast: ProjectForecast | undefined) =>
    (forecast?.internalDeadlineAt ?? candidate.internalDeadlineAt ?? candidate.externalDeadlineAt)?.getTime() ??
    Number.MAX_SAFE_INTEGER;
  const targetDeadline = deadlineOf(project, baselineByProject.get(project.id));
  let lastDisplaced: string[] = [];

  for (const minutes of candidates) {
    const simulated = planSchedule({
      ...args,
      actions: args.actions.map((item) =>
        item.id === action.id ? { ...item, remainingMinutes: Math.max(0, item.remainingMinutes - minutes) } : item
      ),
      commitments: [
        ...args.commitments,
        {
          id: "continuation-simulation",
          startsAt: args.now,
          endsAt: new Date(args.now.getTime() + minutes * MINUTE_MS)
        }
      ]
    });
    const displaced = simulated.forecasts
      .filter((forecast) => {
        if (forecast.projectId === project.id) return false;
        const otherProject = args.projects.find((item) => item.id === forecast.projectId)!;
        const baselineForecast = baselineByProject.get(otherProject.id);
        const deadline = deadlineOf(otherProject, baselineForecast);
        const moreImportant =
          deadline < targetDeadline || (deadline === targetDeadline && otherProject.consequence > project.consequence);
        // A drop into at risk or behind counts (not only into behind), since each is a move to a more
        // urgent tier in the main ranking.
        return moreImportant && gotWorse(baselineForecast, forecast);
      })
      .map((forecast) => forecast.projectId);
    lastDisplaced = displaced;
    if (!displaced.length)
      return {
        safe: true,
        recommendedMinutes: minutes,
        reason: `${minutes} minutes fit before ${window.boundary.toISOString()} without making a more urgent project infeasible.`,
        displacedProjectIds: []
      };
  }
  return {
    safe: false,
    recommendedMinutes: 0,
    reason: "Continuing would consume capacity reserved for a more urgent project.",
    displacedProjectIds: lastDisplaced
  };
}

function continuationCandidates(limit: number, minimum: number): number[] {
  const values = new Set<number>([limit, minimum]);
  for (let value = Math.floor(limit / 15) * 15; value >= minimum; value -= 15) values.add(value);
  return [...values].filter((value) => value >= minimum && value <= limit).sort((a, b) => b - a);
}

const HEALTH_ORDER: ProjectForecast["health"][] = ["ahead", "on_track", "at_risk", "behind"];
const AT_RISK = HEALTH_ORDER.indexOf("at_risk");

/**
 * Whether the project dropped into at risk or behind, the tiers the main ranking treats as urgent. Easing
 * from ahead to on track is not displacement; an unmeasured forecast on either side never counts.
 */
export function gotWorse(before: ProjectForecast | undefined, after: ProjectForecast): boolean {
  if (!before) return false;
  const was = HEALTH_ORDER.indexOf(before.health);
  const is = HEALTH_ORDER.indexOf(after.health);
  return was >= 0 && is >= AT_RISK && is > was;
}
