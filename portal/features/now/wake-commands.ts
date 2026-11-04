import { createClientId } from "@/shared/client-id";
import type { ActiveSession, PortalState, StoredRoutineStep } from "@/state/portal-state";
import type { RunActivityCommand } from "@/features/now/now-model";

/**
 * The latest moment the record already covers: the end of the last session, or the last wake if
 * nothing has ended since. A backfilled start may not begin before it (`checkBackfilledStart` refuses
 * an overlap with an earlier session and a start before the last wake).
 */
export function recordedUpTo(
  state: Pick<PortalState, "completedToday" | "lastEndedSessions" | "settings">
): string | undefined {
  const times = [
    ...state.completedToday.map((item) => item.endedAt),
    ...state.lastEndedSessions.map((item) => item.endedAt),
    state.settings.lastWokeAt
  ]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : undefined;
}

/**
 * When a step marked Done is taken to have begun: its planned minutes ago, but never inside recorded
 * time. The floor wins even when the clock estimate trails it: the server takes a small future skew,
 * and refuses an overlap outright.
 */
export function doneStartedAt(step: Pick<StoredRoutineStep, "durationMinutes">, now: Date, notBefore?: string): string {
  const planned = now.getTime() - step.durationMinutes * 60_000;
  const floor = notBefore ? new Date(notBefore).getTime() : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(planned, floor)).toISOString();
}

/**
 * Done on a step that needs no timer: start it, then finish it as completed. The session a start
 * opens takes the start command's id, and a new session is at version 1, so both halves can be sent
 * back to back without waiting on the refreshed state. It starts `startedAt` in the past (the step's
 * planned minutes ago, not before `notBefore`), which the server accepts within its backfill bounds. If the finish is refused the step is left
 * running and the ordinary timer card takes over.
 */
export async function completeStep(
  step: StoredRoutineStep,
  runActivityCommand: RunActivityCommand,
  notBefore?: string,
  now: Date = new Date()
): Promise<void> {
  const sessionId = createClientId();
  await runActivityCommand({
    commandId: sessionId,
    expectedVersion: step.version ?? null,
    type: "start_activity",
    targetType: "routine_step",
    targetId: step.id,
    plannedMinutes: step.durationMinutes,
    // Backfilled, so the step records the minutes it takes rather than a session of about none.
    startedAt: doneStartedAt(step, now, notBefore)
  });
  await runActivityCommand({
    commandId: createClientId(),
    expectedVersion: 1,
    type: "finish_activity",
    sessionId,
    outcome: "completed"
  });
}

/** Skips the given steps in routine order, stopping at the first the server refuses. */
export async function skipSteps(
  steps: readonly StoredRoutineStep[],
  runActivityCommand: RunActivityCommand
): Promise<void> {
  for (const step of steps) {
    if (step.status === "completed" || step.status === "skipped") continue;
    await runActivityCommand({
      commandId: createClientId(),
      expectedVersion: step.version ?? null,
      type: "skip_routine_step",
      stepId: step.id
    });
  }
}

/** I'm awake: closes a sleep, optionally at the moment the person really woke (`endedAt`, an ISO instant). */
export function awakeCommand(session: ActiveSession, endedAt?: string) {
  return {
    commandId: createClientId(),
    expectedVersion: session.version ?? null,
    type: "finish_activity" as const,
    sessionId: session.id,
    outcome: "completed" as const,
    ...(endedAt ? { endedAt } : {})
  };
}

/**
 * The task waiting behind the wake routine, as one line. The first planned action or deliverable in
 * today's projected plan wins, so every step of the routine names the same task; the engine's
 * recommendation, which is empty while a routine directive is current and can show something else on
 * the last step, is the fallback when the plan holds no work. (The queued directives hold only the
 * routine's own siblings, so they are no use here.)
 */
export function nextTaskTitle(
  primary: { action: { title: string } } | null | undefined,
  dayPlanBlocks: readonly { kind: string; title: string }[] | undefined
): string | undefined {
  return (
    dayPlanBlocks?.find((block) => block.kind === "action" || block.kind === "deliverable")?.title ??
    primary?.action.title
  );
}
