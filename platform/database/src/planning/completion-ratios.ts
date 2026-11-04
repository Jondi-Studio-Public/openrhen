import type postgres from "postgres";
import { deriveCompletionRatios, type PortalStateContract, isClosedStatus } from "@openrhen/contracts";

type StoredProject = PortalStateContract["projects"][number];
type StoredAction = PortalStateContract["actions"][number];

/**
 * The forecast horizon `buildPlanForecastRequest` plans against (`platform/database/src/planning/
 * plan-forecast-runtime.ts`). A project whose deadline falls outside it is not being forecast at all,
 * so it gets no baseline — mirrors the "deadline > forecastEnd" guard in
 * `engine/core/src/scheduling/schedule.ts`.
 */
const HORIZON_MS = 180 * 86_400_000;

/**
 * A project's effective deadline for baseline purposes: the internal date, capped at the external one
 * when it runs later (rule), or the external date alone when no internal one is set. This is
 * an approximation of `resolveInternalDeadline` (`engine/core/src/scheduling/schedule.ts`) — it skips
 * that function's submission-buffer fallback for an external-only project (which needs the engine's
 * risk-adjusted remaining minutes to size the buffer) and uses the external date directly instead. The
 * gap only affects *when* a baseline is captured and how quickly `requiredCompletionRatio` climbs for
 * that one case; the schedule itself still runs against the buffered date.
 */
function effectiveDeadline(project: StoredProject): Date | undefined {
  const internal = project.internalDeadlineAt ? new Date(project.internalDeadlineAt) : undefined;
  const external = project.externalDeadlineAt ? new Date(project.externalDeadlineAt) : undefined;
  if (internal) return external && internal.getTime() > external.getTime() ? external : internal;
  return external;
}

interface ProjectScope {
  /** Estimated minutes of actions already done. */
  completedMinutes: number;
  /** Estimated minutes of actions not yet done (and not cancelled/archived). */
  remainingMinutes: number;
}

/**
 * One project's estimated scope right now, from its one-off and cadence actions. A recurring
 * template action is excluded — it names a rule, not a bucket of remaining work, the same filter
 * `engine/core/src/engine.ts`'s `prepare` applies before handing actions to the engine.
 */
function scopeOf(projectId: string, actions: StoredAction[]): ProjectScope {
  let completedMinutes = 0;
  let remainingMinutes = 0;
  for (const action of actions) {
    if (action.projectId !== projectId || action.schedulingMode === "recurring") continue;
    const estimate = action.expectedMinutes ?? action.remainingMinutes ?? 0;
    if (action.status === "done") completedMinutes += estimate;
    else if (!isClosedStatus(action.status)) remainingMinutes += action.remainingMinutes;
  }
  return { completedMinutes, remainingMinutes };
}

export interface ProjectPaceUpdate {
  actualCompletionRatio: number;
  requiredCompletionRatio: number;
}

/**
 * derive `actualCompletionRatio` and `requiredCompletionRatio` for every project that is
 * active, has an effective deadline inside the forecast horizon, and has estimated remaining work —
 * the same gate item 1 of the design gap names for capturing a baseline in the first place. A project
 * outside that gate (paused, no deadline, nothing left to do, or a maintenance/adherence project with
 * no usable deadline at all) is left with whatever ratios it already had; schedule.ts already treats
 * adherence-graded projects as a separate branch that never reads these fields.
 *
 * A qualifying project's baseline (`forecast_started_at`, `baseline_estimate_minutes`) is set once,
 * the first time it qualifies, and never overwritten afterwards — reading it back unchanged on every
 * later run is what makes `requiredCompletionRatio` track real elapsed time. `saveProject`
 * (`portal/server/persistence/postgres/project-commands.ts`) resets both columns to null when a
 * project is re-activated after being paused or archived, so the next qualifying run here captures a
 * fresh baseline for it instead of reusing one from a previous attempt at the project.
 *
 * Returns the derived ratios keyed by project id so the caller can fold them into the state it is
 * about to hand the engine for this same run — the persisted row and the engine's input are the same
 * numbers by construction, never a run apart.
 */
export async function deriveProjectPace(
  sql: postgres.Sql | postgres.TransactionSql,
  projects: StoredProject[],
  actions: StoredAction[],
  now: Date
): Promise<Map<string, ProjectPaceUpdate>> {
  const candidates = projects.filter((project) => {
    if (project.status !== "active") return false;
    const deadline = effectiveDeadline(project);
    if (!deadline || deadline.getTime() > now.getTime() + HORIZON_MS) return false;
    return scopeOf(project.id, actions).remainingMinutes > 0;
  });
  const updates = new Map<string, ProjectPaceUpdate>();
  if (!candidates.length) return updates;
  const rows = await sql<{ id: string; forecast_started_at: Date | null; baseline_estimate_minutes: number | null }[]>`
    SELECT id, forecast_started_at, baseline_estimate_minutes FROM projects
    WHERE id IN ${sql(candidates.map((project) => project.id))}
  `;
  const baselines = new Map(rows.map((row) => [row.id, row]));
  for (const project of candidates) {
    const deadline = effectiveDeadline(project)!;
    const scope = scopeOf(project.id, actions);
    const currentTotalMinutes = scope.completedMinutes + scope.remainingMinutes;
    const stored = baselines.get(project.id);
    const startedAt = stored?.forecast_started_at ?? now;
    const baselineMinutes = stored?.baseline_estimate_minutes ?? currentTotalMinutes;
    if (!stored?.forecast_started_at)
      await sql`
        UPDATE projects SET forecast_started_at=${startedAt}, baseline_estimate_minutes=${baselineMinutes}
        WHERE id=${project.id}
      `;
    const ratios = deriveCompletionRatios({
      baselineMinutes,
      completedMinutes: scope.completedMinutes,
      currentTotalMinutes,
      startedAt,
      deadline,
      now
    });
    await sql`
      UPDATE projects SET actual_completion_ratio=${ratios.actualCompletionRatio}, required_completion_ratio=${ratios.requiredCompletionRatio}
      WHERE id=${project.id}
    `;
    updates.set(project.id, ratios);
  }
  return updates;
}
