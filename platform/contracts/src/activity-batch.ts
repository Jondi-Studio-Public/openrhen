import {
  ACTIVITY_COVERAGE_KIND,
  activityEnvelopeSchema,
  validateActivityEvent,
  type ActivityEventVerdict,
  type ActivityRejection,
  type ActivitySourceEntry,
  type ValidActivityEvent
} from "./activity-events.js";

/**
 * Whole-batch checking for adapter authors and for the store: the per-event rules plus the rules that need the other
 * events of the batch. Pure: no database, no clock (the caller passes `now`). Nothing in the engine reads it.
 * See the new-data-sources design, section 3.2.
 */

/** One event's verdict with the source its raw event named; `source` is null when the source could not be read. */
export interface CoverageRuleInput {
  verdict: ActivityEventVerdict;
  source: string | null;
}

/**
 * The coverage post-pass. Refuses a coverage row when any other event of the same source was rejected (whatever its
 * scope), or when a rejected event's source could not be read, so a window is never declared complete over rows that
 * were not stored. Run it after per-event validation and after the store's import-source rejections. Returns one
 * verdict per input, in order; only accepted coverage rows can change.
 */
export function applyCoverageRule(inputs: readonly CoverageRuleInput[]): ActivityEventVerdict[] {
  const firstRejectedBySource = new Map<string, number>();
  let firstUnreadable = -1;
  inputs.forEach((input, index) => {
    if (input.verdict.ok) return;
    if (input.source === null) {
      if (firstUnreadable < 0) firstUnreadable = index;
    } else if (!firstRejectedBySource.has(input.source)) firstRejectedBySource.set(input.source, index);
  });
  return inputs.map((input) => {
    const { verdict } = input;
    if (!verdict.ok || verdict.event.kind !== ACTIVITY_COVERAGE_KIND) return verdict;
    const source = verdict.event.source;
    // The first rejected event of the source that is not this row (it is accepted, so it never matches itself).
    const sameSource = firstRejectedBySource.get(source);
    const target = sameSource ?? (firstUnreadable >= 0 ? firstUnreadable : undefined);
    if (target === undefined) return verdict;
    const rejected = inputs[target]!.verdict;
    const why = rejected.ok ? "" : rejected.reason.slice(0, 160);
    const subject =
      sameSource !== undefined
        ? `event #${target} of ${source} was rejected`
        : `event #${target} was rejected and its source could not be read`;
    return {
      ok: false,
      reason: `coverage refused: ${subject} (${why}); fix it and resend the batch, or send coverage in a later batch after every row is accepted`
    };
  });
}

export interface ActivityBatchOptions {
  /** The sources to judge against: the core registry plus any extension's. */
  registry: Readonly<Record<string, ActivitySourceEntry>>;
  now: Date;
  /** True when the source's family scopes coverage, so a coverage row must carry `attrs.scope`. */
  scopeRequired?: ((source: string) => boolean) | undefined;
}

export type ActivityBatchResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      /** One verdict per event, in order, after the coverage post-pass. */
      verdicts: ActivityEventVerdict[];
      accepted: ValidActivityEvent[];
      rejected: ActivityRejection[];
    };

/**
 * Judges a whole batch body the way the ingest route will: the envelope, then each event alone, then the coverage
 * post-pass. A batch with an `import` is not live (older coverage windows are allowed). The same function runs in an
 * adapter's tests, so what passes here is accepted by the server.
 */
export function validateActivityBatch(batch: unknown, options: ActivityBatchOptions): ActivityBatchResult {
  const envelope = activityEnvelopeSchema.safeParse(batch);
  if (!envelope.success) {
    const issue = envelope.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, reason: `batch is not valid: ${where}${issue?.message ?? "wrong shape"}.` };
  }
  const { device, events } = envelope.data;
  const live = envelope.data.import === undefined && envelope.data.importId === undefined;
  const inputs: CoverageRuleInput[] = events.map((raw) => {
    const record = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    const named = record?.source;
    const source = typeof named === "string" && Object.hasOwn(options.registry, named) ? named : null;
    return {
      verdict: validateActivityEvent(raw, options.now, {
        registry: options.registry,
        device,
        live,
        scopeRequired: options.scopeRequired
      }),
      source
    };
  });
  const verdicts = applyCoverageRule(inputs);
  const accepted: ValidActivityEvent[] = [];
  const rejected: ActivityRejection[] = [];
  verdicts.forEach((verdict, index) => {
    if (verdict.ok) accepted.push(verdict.event);
    else rejected.push({ index, reason: verdict.reason });
  });
  return { ok: true, verdicts, accepted, rejected };
}
