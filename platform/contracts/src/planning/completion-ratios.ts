/**
 * the two numbers `scheduleVariance` is built from (`engine/core/src/scheduling/schedule.ts`)
 * — pure arithmetic over a project's baseline, so both the database layer that derives them and the
 * engine's tests that pin their behaviour share one definition.
 *
 * `actualCompletionRatio` measures work done against the larger of the baseline scope and the
 * current one: a baseline set when the project first became forecastable, or its current total if
 * more work has since been added. Using the larger of the two means adding work after the baseline
 * lowers the ratio rather than letting it exceed 1 — the project got bigger, so "done" shrank as a
 * fraction of it, exactly as it should.
 *
 * `requiredCompletionRatio` measures time elapsed since that same baseline against the time between
 * the baseline and the deadline. Both are clamped to [0, 1]: a ratio outside that range would mean
 * "more than everything" or "less than nothing," neither of which is a report about progress.
 */
export interface CompletionRatioInputs {
  /** Total estimated minutes (completed + remaining) captured when the project first became forecastable. */
  baselineMinutes: number;
  /** Estimated minutes of work completed since the baseline. */
  completedMinutes: number;
  /** Total estimated minutes (completed + remaining) right now. */
  currentTotalMinutes: number;
  /** When the baseline was captured — `projects.forecast_started_at`. */
  startedAt: Date;
  /** The project's effective deadline. */
  deadline: Date;
  /** The instant this forecast is being computed for. */
  now: Date;
}

export interface CompletionRatios {
  actualCompletionRatio: number;
  requiredCompletionRatio: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function deriveCompletionRatios(inputs: CompletionRatioInputs): CompletionRatios {
  const scope = Math.max(inputs.baselineMinutes, inputs.currentTotalMinutes, 1);
  const actualCompletionRatio = clamp01(inputs.completedMinutes / scope);
  const totalMs = inputs.deadline.getTime() - inputs.startedAt.getTime();
  const elapsedMs = inputs.now.getTime() - inputs.startedAt.getTime();
  // A deadline at or before the baseline (already overdue when the baseline was set, or a same-instant
  // edge case) has no runway left to measure elapsed time as a fraction of: all of it is required now.
  const requiredCompletionRatio = totalMs > 0 ? clamp01(elapsedMs / totalMs) : 1;
  return { actualCompletionRatio, requiredCompletionRatio };
}
