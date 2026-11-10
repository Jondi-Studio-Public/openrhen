import type { ProjectForecast } from "../model/types.js";

/**
 * Deadline outlook: a verdict per project and per outcome, derived only from the forecasts the
 * scheduler already produced. It adds no scheduling maths: `ok` is on track or ahead, `tight` is at
 * risk, `behind` is a negative expected margin with the deadline still ahead, `overdue` is a deadline
 * that has passed. `none` means there is nothing to alert on (no deadline, a maintenance project, or a
 * project that is not being worked).
 */
export type DeadlineVerdict = "ok" | "tight" | "behind" | "overdue" | "none";

export interface DeadlineProjectInput {
  id: string;
  title?: string;
  outcomeId?: string | null;
  status: string;
  externalDeadlineAt?: Date | null;
  internalDeadlineAt?: Date | null;
}

export interface DeadlineOutcomeInput {
  id: string;
  title?: string;
  status: string;
  deadlineAt?: Date | null;
}

export interface DeadlineProjectRow {
  projectId: string;
  title: string | null;
  outcomeId: string | null;
  verdict: Exclude<DeadlineVerdict, "none">;
  deadlineAt: Date | null;
  /** Expected margin in minutes (negative when the expected work does not fit). */
  slackMinutes: number | null;
  pessimisticMarginMinutes: number | null;
  /** Earliest of the forecast's latest safe starts, when any is known. */
  latestSafeStart: Date | null;
  /** Overdue rows only: when the remaining work would fit; null means nowhere inside the horizon. */
  earliestFeasibleAt?: Date | null;
}

export interface DeadlineOutcomeRow {
  outcomeId: string;
  title: string | null;
  verdict: Exclude<DeadlineVerdict, "none">;
  /** Earlier of the outcome's own deadline and its earliest project deadline. */
  deadlineAt: Date | null;
  /** The smallest slack among its projects. */
  slackMinutes: number | null;
  latestSafeStart: Date | null;
  projectIds: string[];
}

export interface DeadlineOutlook {
  projects: DeadlineProjectRow[];
  outcomes: DeadlineOutcomeRow[];
}

export interface AssessDeadlinesArguments {
  forecasts: ProjectForecast[];
  projects: DeadlineProjectInput[];
  outcomes: DeadlineOutcomeInput[];
  now: Date;
}

const RANK: Record<DeadlineVerdict, number> = { none: -1, ok: 0, tight: 1, behind: 2, overdue: 3 };

export function assessDeadlines(args: AssessDeadlinesArguments): DeadlineOutlook {
  const projectsById = new Map(args.projects.map((project) => [project.id, project]));
  const outcomesById = new Map(args.outcomes.map((outcome) => [outcome.id, outcome]));
  const rows: DeadlineProjectRow[] = [];

  for (const forecast of args.forecasts) {
    const project = projectsById.get(forecast.projectId);
    if (!project || project.status !== "active") continue;
    const outcome = project.outcomeId ? outcomesById.get(project.outcomeId) : undefined;
    if (project.outcomeId && (!outcome || outcome.status !== "active")) continue;
    if (forecast.healthBasis === "adherence" || forecast.deadlineSource === undefined) continue;
    if (forecast.deadlineSource === "none") continue;
    const verdict = projectVerdict(forecast, project, args.now);
    if (verdict === "none") continue;
    const external = project.externalDeadlineAt ?? null;
    const internal = forecast.internalDeadlineAt ?? project.internalDeadlineAt ?? null;
    const row: DeadlineProjectRow = {
      projectId: forecast.projectId,
      title: project.title ?? null,
      outcomeId: project.outcomeId ?? null,
      verdict,
      deadlineAt: forecast.deadlineSource === "external" ? (external ?? internal) : (internal ?? external),
      slackMinutes: forecast.expectedMarginMinutes,
      pessimisticMarginMinutes: forecast.pessimisticMarginMinutes,
      latestSafeStart: earliest(Object.values(forecast.latestSafeStarts))
    };
    if (verdict === "overdue") row.earliestFeasibleAt = forecast.proposal?.earliestFeasibleAt ?? null;
    rows.push(row);
  }
  rows.sort(compareRows);

  const byOutcome = new Map<string, DeadlineProjectRow[]>();
  for (const row of rows) {
    if (!row.outcomeId) continue;
    byOutcome.set(row.outcomeId, [...(byOutcome.get(row.outcomeId) ?? []), row]);
  }
  const outcomes: DeadlineOutcomeRow[] = [];
  for (const [outcomeId, children] of byOutcome) {
    const outcome = outcomesById.get(outcomeId)!;
    const slacks = children.map((child) => child.slackMinutes).filter((value): value is number => value !== null);
    outcomes.push({
      outcomeId,
      title: outcome.title ?? null,
      verdict: children.reduce<DeadlineProjectRow["verdict"]>(
        (worst, child) => (RANK[child.verdict] > RANK[worst] ? child.verdict : worst),
        "ok"
      ),
      deadlineAt: earliest([outcome.deadlineAt ?? null, ...children.map((child) => child.deadlineAt)]),
      slackMinutes: slacks.length ? Math.min(...slacks) : null,
      latestSafeStart: earliest(children.map((child) => child.latestSafeStart)),
      projectIds: children.map((child) => child.projectId).sort((a, b) => a.localeCompare(b))
    });
  }
  outcomes.sort((a, b) =>
    compareRows(
      { verdict: a.verdict, slackMinutes: a.slackMinutes, id: a.outcomeId },
      { verdict: b.verdict, slackMinutes: b.slackMinutes, id: b.outcomeId }
    )
  );
  return { projects: rows, outcomes };
}

function projectVerdict(forecast: ProjectForecast, project: DeadlineProjectInput, now: Date): DeadlineVerdict {
  if (forecast.overdue) {
    // The self-set date has passed but the external date is still ahead: the commitment stands as long
    // as the work still fits before it. A real shortfall is never silenced.
    const external = project.externalDeadlineAt ?? null;
    if (forecast.deadlineSource === "internal" && external && external.getTime() > now.getTime()) {
      const feasible = forecast.proposal?.earliestFeasibleAt ?? null;
      return feasible && feasible.getTime() <= external.getTime() ? "tight" : "overdue";
    }
    return "overdue";
  }
  switch (forecast.health) {
    case "on_track":
    case "ahead":
      return "ok";
    case "at_risk":
      return "tight";
    case "behind":
      return "behind";
    default:
      return "none";
  }
}

function earliest(dates: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const date of dates) if (date && (!best || date.getTime() < best.getTime())) best = date;
  return best;
}

function compareRows(
  a: { verdict: string; slackMinutes: number | null; projectId?: string; id?: string },
  b: { verdict: string; slackMinutes: number | null; projectId?: string; id?: string }
): number {
  const overdue = Number(b.verdict === "overdue") - Number(a.verdict === "overdue");
  if (overdue) return overdue;
  const slackA = a.slackMinutes ?? Number.POSITIVE_INFINITY;
  const slackB = b.slackMinutes ?? Number.POSITIVE_INFINITY;
  if (slackA !== slackB) return slackA < slackB ? -1 : 1;
  return (a.projectId ?? a.id ?? "").localeCompare(b.projectId ?? b.id ?? "");
}
