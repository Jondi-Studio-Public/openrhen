/** One step of a routine being written onto a commitment, in sequence order. */
export interface CommitmentRoutineStepInput {
  title: string;
  durationMinutes: number;
  timingRule: "contiguous" | "flexible";
  maxLeadMinutes: number | null;
  energy: string;
  phase: "before" | "after";
  contexts: string[];
  actionWindowId: string | null;
  /**
   * The cadence action this step stands in for, so completing the step also records the cadence
   * completion — mutually exclusive with `actionWindowId` (mirrors `routineSteps`'s DB check
   * constraint, `platform/database/src/schema.ts`). A preset step carrying this is only included in
   * `syncInheritedRoutineSteps`'s template when the cadence is actually due today — see the gate there.
   */
  cadenceActionId: string | null;
  /**
   * The `routine_preset_steps.id` this template step came from, when there is one — null for a step
   * that never came from a preset (import review). `planRoutineStepReconciliation` matches an existing
   * row to a template step by this id first, before falling back to position.
   */
  presetStepId: string | null;
  /** Positions (indexes into the step list) of the steps this one depends on. */
  dependsOn: number[];
  /**
   * Sleep-anchored templates only (`reconcileSleepRoutineSteps`): the engine has already
   * decided this step's own status (`'pending'` or `'skipped'`, the latter for a wake-truncation drop —
   * a cadence-gated-out step is never in the template at all, mirroring the commitment path) and its own
   * `scheduledStartAt`/`scheduledEndAt`, computed forward from the anchor's own start — there is no
   * `commitments` row for `computeRoutineStepSchedule` to chain from. `undefined` for a
   * commitment-anchored template, which always inserts `'pending'` with schedule left to
   * `writeRoutineStepSchedule`, exactly as before this field existed.
   */
  status?: "pending" | "skipped";
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  /** Minutes to wait after this step completes before its dependents can start (default 0). */
  waitAfterMinutes?: number;
  /** Latest start time for this step, in minutes before the anchor's boundary (or after, for forward chains). */
  mustStartByMinutes?: number | null;
  /** Time band ids this step prefers to run in, in order (default []). */
  preferredBands?: string[];
}

/**
 * One existing `routine_steps` row as reconciliation sees it: enough to tell whether it
 * already matches its template counterpart. `sequence` is the row's own stored position, needed to
 * detect a row that is otherwise unchanged but has moved to a different template index (an insertion
 * or deletion elsewhere in the preset shifts everything after it). `presetStepId` is the row's
 * `routine_preset_steps.id` link — null for a hand-added step or one written before that column
 * existed. `dependsOnIds` are the real ids the row currently points to in
 * `routine_step_dependencies` — compared as a set, since dependency order carries no
 * meaning of its own.
 */
export interface ExistingRoutineStepForPlan {
  id: string;
  status: string;
  sequence: number;
  presetStepId: string | null;
  title: string;
  durationMinutes: number;
  timingRule: "contiguous" | "flexible";
  maxLeadMinutes: number | null;
  energy: string;
  phase: "before" | "after";
  contexts: string[];
  actionWindowId: string | null;
  /** Mirrors `CommitmentRoutineStepInput.cadenceActionId` above — see the comment there. */
  cadenceActionId: string | null;
  dependsOnIds: string[];
  /**
   * Sleep-anchored rows only — compared against `CommitmentRoutineStepInput.scheduledStartAt`/
   * `scheduledEndAt` so a pending row's cached schedule stays in step with the sleep plan's own,
   * possibly-shifted boundary rather than silently going stale once every other field already matches.
   * `undefined` for a commitment-anchored row, which never compares them (its schedule always comes
   * from the separate `writeRoutineStepSchedule` pass instead).
   */
  scheduledStartAt?: Date | null;
  scheduledEndAt?: Date | null;
  /** Minutes to wait after this step completes before its dependents can start (default 0). */
  waitAfterMinutes?: number;
  /** Latest start time for this step, in minutes before the anchor's boundary (or after, for forward chains). */
  mustStartByMinutes?: number | null;
  /** Time band ids this step prefers to run in, in order (default []). */
  preferredBands?: string[];
}

export type RoutineStepPlanOp =
  | { kind: "keep"; id: string }
  | { kind: "reseq"; id: string; sequence: number }
  | {
      kind: "update";
      id: string;
      templateIndex: number;
      sequence: number;
      step: CommitmentRoutineStepInput;
      dependsOnIds: string[];
    }
  | {
      kind: "insert";
      id: string;
      templateIndex: number;
      sequence: number;
      step: CommitmentRoutineStepInput;
      dependsOnIds: string[];
    }
  | { kind: "delete"; id: string };

/** One row of the reconciled step list, in final sequence order — enough to reschedule the chain. */
export interface RoutineStepScheduleRow {
  id: string;
  phase: "before" | "after";
  durationMinutes: number;
  status: string;
  contexts: string[];
}

export interface RoutineStepReconciliationPlan {
  ops: RoutineStepPlanOp[];
  /** True when at least one op is not "keep" — the short-circuit for "this commitment needs no writes". */
  changed: boolean;
  /** The reconciled step list — locked rows kept, pending rows updated/inserted, deletions dropped —
   *  in final sequence order, ready to feed `computeRoutineStepSchedule`. */
  finalSteps: RoutineStepScheduleRow[];
}

export const contextList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const sameStringSequence = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((item, index) => item === right[index]);

const sameStringSet = (left: readonly string[], right: readonly string[]): boolean => {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((item, index) => item === sortedRight[index]);
};

/** Groups dependency edges into per-step position lists, given the ordered ids of one step list. */
export function dependencyPositions(
  orderedIds: readonly string[],
  edges: ReadonlyArray<{ step_id: string; depends_on_step_id: string }>
): number[][] {
  const position = new Map(orderedIds.map((id, index) => [id, index]));
  const result: number[][] = orderedIds.map(() => []);
  for (const edge of edges) {
    const from = position.get(edge.step_id);
    const to = position.get(edge.depends_on_step_id);
    if (from !== undefined && to !== undefined) result[from]!.push(to);
  }
  return result;
}

/**
 * Reconciles one commitment's stored routine steps against its resolved preset in place (see the
 * design note, the routine sync step level design note, and its follow-up). Matches an existing
 * row to a template step first by `presetStepId` — the stable `routine_preset_steps.id` link, which
 * survives either list reordering around it — and only falls back to absolute position for a row with
 * no id (predates the column, or was never preset-derived): the two lists shared no other identity
 * before this column existed, and position-matching is sound only for such a row, one at a time,
 * against the template steps id-matching left unclaimed, in each side's own relative order.
 *
 * A non-pending (`status<>'pending'`) row's content is never rewritten — it is a record of the day,
 * kept exactly as it is — but it still *occupies* whichever template step it matched (by id or by
 * position): that template step is matched to it only so a later step's dependency on it resolves to
 * its real id, and is otherwise ignored, even once its content (or, for an id match, its position) has
 * drifted from the template. A pending row matched to a template step is updated in place (same id, so
 * `action_window_id` links and dependency edges naming it survive) when content differs or the row's
 * own `presetStepId`/position needs backfilling to the match just found; left alone (no write at all)
 * when it already matches exactly; deleted when no template step claims it. A template step with no
 * matched row is inserted fresh.
 *
 * A locked row that matches no template step at all (the position fallback left it unclaimed on both
 * sides — typically a step whose preset step was since deleted) is never deleted, but it still needs a
 * place in the final order: it keeps the relative position it held before, sorted immediately after
 * whichever template step was the last one matched (by id or position) ahead of it in the row's own
 * stored order, or at the very front if none was. Every row's final `sequence` — locked rows included
 * — is then just its index in that fully merged order (template steps interleaved with any such
 * unclaimed locked rows), so the result is always a contiguous `0..n-1` run in true routine order. A
 * locked row only ever gets a write (`reseq`, not `update` — its content stays put) when that computed
 * sequence differs from what it already has; an already-correct commitment still produces zero writes.
 */
export function planRoutineStepReconciliation(
  existing: readonly ExistingRoutineStepForPlan[],
  template: readonly CommitmentRoutineStepInput[],
  // Takes the template index so a sleep-anchored caller (`reconcileSleepRoutineSteps`) can hand a
  // genuinely new row the same deterministic id the engine's own `deriveSleepRoutineSteps` already
  // computed for that same step this run — otherwise the id this call assigns and the id the
  // just-returned plan-forecast response already named in `currentDirective`/the day plan would disagree,
  // and the very next `start_activity` against it would fail `currentEngineResultIncludesActivity`. The
  // commitment path never overrides this: a fresh commitment step's id has never needed to agree with
  // anything computed outside this call.
  generateId: (templateIndex: number) => string = () => crypto.randomUUID()
): RoutineStepReconciliationPlan {
  // Stage 1 — id match.
  const templateIndexByPresetStepId = new Map<string, number>();
  template.forEach((step, index) => {
    if (step.presetStepId && !templateIndexByPresetStepId.has(step.presetStepId))
      templateIndexByPresetStepId.set(step.presetStepId, index);
  });
  const rowByTemplateIndex = new Map<number, ExistingRoutineStepForPlan>();
  const unmatchedExisting: ExistingRoutineStepForPlan[] = [];
  for (const row of existing) {
    const templateIndex = row.presetStepId ? templateIndexByPresetStepId.get(row.presetStepId) : undefined;
    if (templateIndex !== undefined && !rowByTemplateIndex.has(templateIndex))
      rowByTemplateIndex.set(templateIndex, row);
    else unmatchedExisting.push(row);
  }
  // Stage 2 — position fallback, for whatever id matching left unclaimed on both sides, preserving
  // each side's own relative order.
  const unmatchedTemplateIndices = template.map((_, index) => index).filter((index) => !rowByTemplateIndex.has(index));
  const fallbackLength = Math.max(unmatchedExisting.length, unmatchedTemplateIndices.length);
  const deleteIds: string[] = [];
  const extraLockedRows: ExistingRoutineStepForPlan[] = [];
  for (let k = 0; k < fallbackLength; k++) {
    const row = unmatchedExisting[k];
    const templateIndex = unmatchedTemplateIndices[k];
    if (templateIndex !== undefined) {
      if (row) rowByTemplateIndex.set(templateIndex, row);
      continue; // No row at all for this template step: left as an insert, decided in the main pass.
    }
    if (!row) continue; // unreachable — fallbackLength bounds both arrays — kept for clarity.
    if (row.status === "pending") deleteIds.push(row.id);
    else extraLockedRows.push(row);
  }
  // Every template index now maps to at most one matched row. Resolve final ids up front — a
  // dependsOn position always refers to the original template array — so it is ready before any
  // keep/update decision needs it: a fallback match's id needs backfilling even when nothing else
  // about the row differs.
  const finalIdByTemplateIndex = new Map<number, string>();
  template.forEach((step, index) => {
    const row = rowByTemplateIndex.get(index);
    finalIdByTemplateIndex.set(index, row ? row.id : generateId(index));
  });
  const resolveDependsOn = (templateIndex: number, step: CommitmentRoutineStepInput): string[] =>
    step.dependsOn.map((position) => {
      const id = finalIdByTemplateIndex.get(position);
      if (id === undefined || position === templateIndex) throw new Error("A routine connection is invalid.");
      return id;
    });
  // Anchor each unclaimed locked row to the template index it trailed in the row's own original
  // order — the last matched template index seen while walking `existing` in stored order — so it
  // sorts back into the same relative spot once every row's sequence is renumbered below. `-1` means
  // "before every template step" (nothing matched ahead of it yet).
  const templateIndexByRowId = new Map<string, number>();
  for (const [templateIndex, row] of rowByTemplateIndex) templateIndexByRowId.set(row.id, templateIndex);
  const extraLockedRowIds = new Set(extraLockedRows.map((row) => row.id));
  const extrasByAnchor = new Map<number, ExistingRoutineStepForPlan[]>();
  let lastMatchedTemplateIndex = -1;
  for (const row of existing) {
    const matchedIndex = templateIndexByRowId.get(row.id);
    if (matchedIndex !== undefined) {
      lastMatchedTemplateIndex = matchedIndex;
      continue;
    }
    if (!extraLockedRowIds.has(row.id)) continue; // deleted (pending, unmatched) — not carried forward.
    const bucket = extrasByAnchor.get(lastMatchedTemplateIndex) ?? [];
    bucket.push(row);
    extrasByAnchor.set(lastMatchedTemplateIndex, bucket);
  }
  const extrasAfter = (anchor: number): ExistingRoutineStepForPlan[] => extrasByAnchor.get(anchor) ?? [];
  const ops: RoutineStepPlanOp[] = [];
  const finalSteps: RoutineStepScheduleRow[] = [];
  const emitLockedRow = (row: ExistingRoutineStepForPlan, sequence: number): void => {
    ops.push(row.sequence === sequence ? { kind: "keep", id: row.id } : { kind: "reseq", id: row.id, sequence });
    finalSteps.push({
      id: row.id,
      phase: row.phase,
      durationMinutes: row.durationMinutes,
      status: row.status,
      contexts: row.contexts
    });
  };
  let sequence = 0;
  for (const row of extrasAfter(-1)) emitLockedRow(row, sequence++);
  template.forEach((step, templateIndex) => {
    const row = rowByTemplateIndex.get(templateIndex);
    const id = finalIdByTemplateIndex.get(templateIndex)!;
    if (row && row.status !== "pending") {
      emitLockedRow(row, sequence++);
    } else {
      const templateSequence = sequence++;
      const dependsOnIds = resolveDependsOn(templateIndex, step);
      if (!row) {
        ops.push({ kind: "insert", id, templateIndex, sequence: templateSequence, step, dependsOnIds });
        finalSteps.push({
          id,
          phase: step.phase,
          durationMinutes: step.durationMinutes,
          status: step.status ?? "pending",
          contexts: step.contexts
        });
      } else {
        const sameTime = (a: Date | null | undefined, b: Date | null | undefined) =>
          (a ?? null)?.getTime() === (b ?? null)?.getTime();
        const alreadyMatches =
          row.presetStepId === step.presetStepId &&
          row.sequence === templateSequence &&
          row.title === step.title &&
          row.durationMinutes === step.durationMinutes &&
          row.timingRule === step.timingRule &&
          row.maxLeadMinutes === step.maxLeadMinutes &&
          row.energy === step.energy &&
          row.phase === step.phase &&
          sameStringSequence(row.contexts, step.contexts) &&
          row.actionWindowId === step.actionWindowId &&
          row.cadenceActionId === step.cadenceActionId &&
          sameStringSet(row.dependsOnIds, dependsOnIds) &&
          // Commitment-anchored templates never set these three, so the comparison is always true for
          // that path (matching behaviour before this field existed); a sleep-anchored template's own
          // status/schedule keeps a pending row from silently going stale once everything else matches.
          row.status === (step.status ?? "pending") &&
          sameTime(row.scheduledStartAt, step.scheduledStartAt) &&
          sameTime(row.scheduledEndAt, step.scheduledEndAt) &&
          (row.waitAfterMinutes ?? 0) === (step.waitAfterMinutes ?? 0) &&
          (row.mustStartByMinutes ?? null) === (step.mustStartByMinutes ?? null) &&
          sameStringSequence(row.preferredBands ?? [], step.preferredBands ?? []);
        ops.push(
          alreadyMatches
            ? { kind: "keep", id: row.id }
            : { kind: "update", id: row.id, templateIndex, sequence: templateSequence, step, dependsOnIds }
        );
        finalSteps.push({
          id: row.id,
          phase: step.phase,
          durationMinutes: step.durationMinutes,
          status: step.status ?? "pending",
          contexts: step.contexts
        });
      }
    }
    for (const extra of extrasAfter(templateIndex)) emitLockedRow(extra, sequence++);
  });
  for (const id of deleteIds) ops.push({ kind: "delete", id });
  return { ops, changed: ops.some((op) => op.kind !== "keep"), finalSteps };
}
