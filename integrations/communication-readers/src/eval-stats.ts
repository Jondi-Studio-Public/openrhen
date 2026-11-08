/**
 * The measuring half of the eval harness: how an extractor's output is scored against the person's own labels. Pure
 * and deterministic; the server assembles the inputs from stored rows (`eval-report-store.ts`). See
 * docs/architecture/activity-store.md, "The eval report".
 *
 * What a number means, so nobody reads more into it than it holds:
 *   - A label answers one `field` of one subject (a message or a fact). `answer: null` means "there is no such value".
 *   - Precision is over the labelled subjects the extractor wrote a value for (any slice), so it says how often what
 *     the extractor wrote was right.
 *   - Recall is over the random slice only. The stratified draw oversamples what the extractor flags, so it cannot say
 *     what the extractor misses; only a uniform sample can. A label with no slice counts as stratified.
 *   - A few hundred labels show gross failure only. The intervals are 95% Wilson intervals and are wide on purpose.
 */

export interface EvalSubject {
  kind: "message" | "fact";
  id: string;
}

export interface EvalLabel {
  subject: EvalSubject;
  /** Which attr the answer is about. A label with none is counted by the report as unfielded and not scored. */
  field: string | null;
  /** The person's answer; null means the true answer is "no value". */
  answer: unknown;
  /** RFC 3339. */
  at: string;
  slice?: "random" | "stratified" | null | undefined;
  stratum?: string | null | undefined;
}

/** What the active extractor wrote for one subject and field. Absent means it wrote nothing (an abstention). */
export interface EvalPrediction {
  subject: EvalSubject;
  field: string;
  value: unknown;
}

/** A value an extractor wrote by itself (a fact attr or a status), with when. */
export interface AutoWrite {
  subject: EvalSubject;
  field: string;
  value: unknown;
  at: string;
}

/** The person's own later word on the same subject and field: an override's new value, a label's answer, a status. */
export interface PersonCorrection {
  subject: EvalSubject;
  field: string;
  value: unknown;
  at: string;
}

export interface Interval {
  low: number;
  high: number;
}

export interface Rate {
  value: number;
  /** 95% Wilson interval. */
  interval: Interval;
}

const Z_95 = 1.959963984540054;

/** The 95% Wilson score interval for `successes` out of `trials`; null with no trials. */
export function wilsonInterval(successes: number, trials: number, z: number = Z_95): Interval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || successes < 0 || trials < 0)
    throw new Error(
      `wilsonInterval takes whole numbers that are not negative; got successes ${successes} and trials ${trials}. Pass counts, not rates.`
    );
  if (successes > trials)
    throw new Error(
      `wilsonInterval: successes (${successes}) cannot exceed trials (${trials}). Check that the numerator is a subset of the denominator.`
    );
  if (trials === 0) return null;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = (p + z2 / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denominator;
  // All right or all wrong is exactly 1 or 0 at that end; floating point would leave it a hair off.
  return {
    low: successes === 0 ? 0 : Math.max(0, centre - half),
    high: successes === trials ? 1 : Math.min(1, centre + half)
  };
}

function rate(successes: number, trials: number): Rate | null {
  const interval = wilsonInterval(successes, trials);
  return interval === null ? null : { value: successes / trials, interval };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

const isPlain = (value: unknown): value is string | number | boolean =>
  ["string", "number", "boolean"].includes(typeof value);

/**
 * Structural equality, whatever the key order. `undefined` counts as null (a missing value is "no value"). A list of
 * plain values (reason codes, for one) is a set: its order means nothing, so it is sorted first. A list of objects
 * keeps its order.
 */
function setsOfPlain(value: unknown): unknown {
  if (Array.isArray(value) && value.every(isPlain))
    return [...new Set(value.map((item) => JSON.stringify(item)))].sort();
  if (Array.isArray(value)) return value.map(setsOfPlain);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, setsOfPlain(item)])
    );
  return value;
}
const text = (value: unknown): string => JSON.stringify(canonical(setsOfPlain(value ?? null)));
const same = (a: unknown, b: unknown): boolean => text(a) === text(b);

const subjectKey = (subject: EvalSubject, field: string) => `${subject.kind}\u0000${subject.id}\u0000${field}`;
const instant = (value: string): number => Date.parse(value);

export interface FieldMetrics {
  field: string;
  /** Distinct subjects labelled for this field (latest label each). */
  labelled: number;
  /** Of those, how many the extractor wrote a value for. */
  predicted: number;
  /** Of those, how many it wrote the labelled value for. */
  correct: number;
  /** Labelled subjects in the random slice, and how many of them truly have a value, and how many it got right. */
  randomLabelled: number;
  randomPresent: number;
  randomCorrect: number;
  precision: Rate | null;
  recall: Rate | null;
}

/** Per-field precision and recall with Wilson intervals, sorted by field name. Labels with no field are not scored. */
export function fieldMetrics(labels: readonly EvalLabel[], predictions: readonly EvalPrediction[]): FieldMetrics[] {
  const predicted = new Map<string, unknown>();
  for (const prediction of predictions)
    predicted.set(subjectKey(prediction.subject, prediction.field), prediction.value);

  // The latest label wins for a subject and field; equal times fall back to the answer's text so input order never matters.
  const latest = new Map<string, EvalLabel & { field: string }>();
  // A subject labelled again keeps the slice of its earliest labelled slice: re-labelling is a correction of the answer,
  // not a new draw, so it must not move a message out of (or into) the random slice.
  const firstSlice = new Map<string, { at: number; slice: "random" | "stratified" }>();
  for (const candidate of labels) {
    if (candidate.field === null) continue;
    const entry = candidate as EvalLabel & { field: string };
    const key = subjectKey(entry.subject, entry.field);
    if (entry.slice === "random" || entry.slice === "stratified") {
      const held = firstSlice.get(key);
      if (held === undefined || instant(entry.at) < held.at)
        firstSlice.set(key, { at: instant(entry.at), slice: entry.slice });
    }
    const held = latest.get(key);
    if (
      held === undefined ||
      instant(entry.at) > instant(held.at) ||
      (instant(entry.at) === instant(held.at) && text(entry.answer) > text(held.answer))
    )
      latest.set(key, entry);
  }

  const byField = new Map<string, FieldMetrics>();
  for (const [key, entry] of [...latest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const metrics =
      byField.get(entry.field) ??
      ({
        field: entry.field,
        labelled: 0,
        predicted: 0,
        correct: 0,
        randomLabelled: 0,
        randomPresent: 0,
        randomCorrect: 0,
        precision: null,
        recall: null
      } satisfies FieldMetrics);
    byField.set(entry.field, metrics);
    metrics.labelled += 1;
    const wrote = predicted.has(key) && predicted.get(key) !== null && predicted.get(key) !== undefined;
    const right = wrote && same(predicted.get(key), entry.answer);
    if (wrote) metrics.predicted += 1;
    if (right) metrics.correct += 1;
    if (firstSlice.get(key)?.slice === "random") {
      metrics.randomLabelled += 1;
      if (entry.answer !== null && entry.answer !== undefined) {
        metrics.randomPresent += 1;
        if (right) metrics.randomCorrect += 1;
      }
    }
  }
  return [...byField.values()]
    .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0))
    .map((metrics) => ({
      ...metrics,
      precision: rate(metrics.correct, metrics.predicted),
      recall: rate(metrics.randomCorrect, metrics.randomPresent)
    }));
}

export interface WrongAutoAction {
  subject: EvalSubject;
  field: string;
  written: unknown;
  corrected: unknown;
}

/**
 * The extractor-written values the person later overrode or labelled differently. For each subject and field the
 * person's latest word is compared with the latest value the extractor had written before it; one count per subject
 * and field. The count is the whole total; `items` lists the first `listed` (default 50) in a stable order. A correction that agrees with the extractor, or that came before the write, is not a wrong action.
 * Mark's overrides are not passed in: only the person's own word counts.
 */
export const WRONG_AUTO_ACTIONS_LISTED = 50;

export function wrongAutoActions(
  writes: readonly AutoWrite[],
  corrections: readonly PersonCorrection[],
  listed: number = WRONG_AUTO_ACTIONS_LISTED
): { count: number; items: WrongAutoAction[]; truncated: boolean } {
  const lastWord = new Map<string, PersonCorrection>();
  for (const correction of corrections) {
    const key = subjectKey(correction.subject, correction.field);
    const held = lastWord.get(key);
    if (
      held === undefined ||
      instant(correction.at) > instant(held.at) ||
      (instant(correction.at) === instant(held.at) && text(correction.value) > text(held.value))
    )
      lastWord.set(key, correction);
  }
  const items: WrongAutoAction[] = [];
  for (const [key, word] of [...lastWord].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let current: AutoWrite | undefined;
    for (const write of writes) {
      if (subjectKey(write.subject, write.field) !== key || !(instant(write.at) < instant(word.at))) continue;
      if (
        current === undefined ||
        instant(write.at) > instant(current.at) ||
        (instant(write.at) === instant(current.at) && text(write.value) > text(current.value))
      )
        current = write;
    }
    if (current !== undefined && !same(current.value, word.value))
      items.push({ subject: word.subject, field: word.field, written: current.value, corrected: word.value });
  }
  return { count: items.length, items: items.slice(0, listed), truncated: items.length > listed };
}

export interface T0Share {
  messages: number;
  resolvedByT0: number;
  share: number | null;
  interval: Interval | null;
}

/** The fraction of messages whose class came from headers alone (tier t0), with its Wilson interval. */
export function t0Share(input: { messages: number; resolvedByT0: number }): T0Share {
  const { messages, resolvedByT0 } = input;
  if (!Number.isInteger(messages) || !Number.isInteger(resolvedByT0) || messages < 0 || resolvedByT0 < 0)
    throw new Error(
      `t0Share takes whole numbers that are not negative; got messages ${messages} and resolvedByT0 ${resolvedByT0}.`
    );
  if (resolvedByT0 > messages)
    throw new Error(
      `t0Share: resolvedByT0 (${resolvedByT0}) cannot exceed messages (${messages}). Count messages that have a t0 msg_class row against all messages of the same source.`
    );
  return {
    messages,
    resolvedByT0,
    share: messages === 0 ? null : resolvedByT0 / messages,
    interval: wilsonInterval(resolvedByT0, messages)
  };
}
