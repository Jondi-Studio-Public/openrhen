import { type EvalLabel, type EvalPrediction, type Rate, rate, resolveLabels } from "./eval-stats.js";

/**
 * Scoring facts. Pure and deterministic; the server assembles the rows (`eval-report-store.ts`). See
 * docs/architecture/activity-store.md, "The eval report".
 *
 * A message label with the field `fact_types` answers "which kinds of fact does this message hold": a set, where `[]`
 * is the real answer "none" (not `null`, which is unreadable here). Four traps this module avoids:
 *   - Recall is per type, by membership, never one exact-set-equality figure: a message labelled {ask, deadline} and
 *     predicted {ask} is a hit for ask and a miss for deadline.
 *   - A message the extractor never reached has no fact rows because it never looked, so it is not a correct negative.
 *     Only a message inside the extractor's processed range (or one that has a fact row) is scored; the rest are
 *     counted as `notReached` and left out of every rate.
 *   - Labelled-empty messages say how often the extractor invents a fact. That is a false-alarm rate of its own; they
 *     are never in a recall denominator, and the easy empty messages cannot inflate recall.
 *   - The same message can be labelled for four types at once, and each type gets its own 95% Wilson interval with the
 *     positive count beside it. The intervals are not adjusted for comparing four of them, and with few positives they
 *     are wide: read them as a guide for gross failure, never as a pass or fail.
 * A fact labelled under one version's id is found in a candidate version, whose ids differ, by the same message and an
 * overlapping span (`fallbackFactPredictions`).
 */

/** `communication-readers` keeps its own copy of the vocabulary; portal/server/activity-derived-vocabulary.test.ts keeps it equal. */
export const FACT_TYPES = ["ask", "commitment", "event", "deadline"] as const;

export interface FactSpan {
  start: number;
  end: number;
}

/** One fact row of the version being scored. */
export interface FactRow {
  /** The message it was read from (`attrs.source_event_id`). */
  messageId: string;
  factId: string;
  factType: string;
  span?: FactSpan | null | undefined;
  /** All attrs of the row; the fallback join turns them into predictions for the labelled id. */
  attrs?: Record<string, unknown> | undefined;
}

/** A labelled fact as some version wrote it: which message it is about and where in it. */
export interface FactReference {
  factId: string;
  messageId: string;
  span?: FactSpan | null | undefined;
}

export interface FactEvalInput {
  labels: readonly EvalLabel[];
  rows: readonly FactRow[];
  /** Labelled messages inside the extractor's processed range. */
  reached: Iterable<string>;
  references?: readonly FactReference[] | undefined;
}

export interface FactTypeMetrics {
  type: string;
  /** Scored messages in any slice whose label holds this type. */
  labelledPositives: number;
  /** Scored random-slice messages whose label holds this type: the recall denominator. */
  randomPositives: number;
  /** Of those, how many the extractor wrote this type for. */
  hits: number;
  /** Scored messages (any slice) the extractor wrote this type for, and how many the label agrees with. */
  predicted: number;
  correct: number;
  precision: Rate | null;
  recall: Rate | null;
}

export interface FalseAlarms {
  /** Scored random-slice messages labelled `[]`, and how many of them the extractor wrote a fact for. */
  labelledEmpty: number;
  flagged: number;
  rate: Rate | null;
  /** The same counts over every slice (a stratified draw oversamples what the extractor flags, so no rate). */
  allSlices: { labelledEmpty: number; flagged: number };
}

export interface FactMetrics {
  /** Messages with a `fact_types` label (latest each). */
  labelledMessages: number;
  /** Of those, how many were inside the processed range or had a fact row, so they are scored. */
  scored: number;
  /** Labelled messages the extractor had not reached: not a correct negative, not a miss. */
  notReached: number;
  /** Labels whose answer is not a list of types (`null`, a string): not scored. */
  unreadable: number;
  types: FactTypeMetrics[];
  falseAlarms: FalseAlarms;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function typesOf(answer: unknown): Set<string> | null {
  if (!Array.isArray(answer)) return null;
  return new Set(answer.filter((item): item is string => typeof item === "string"));
}

/** Per-type recall and precision, and the false-alarm rate, for the labelled messages. */
export function factMetrics(input: FactEvalInput): FactMetrics {
  const reached = new Set(input.reached);
  const predicted = new Map<string, Set<string>>();
  for (const row of input.rows) {
    const held = predicted.get(row.messageId) ?? new Set<string>();
    held.add(row.factType);
    predicted.set(row.messageId, held);
  }

  const { latest, firstSlice } = resolveLabels(
    input.labels.filter((label) => label.field === "fact_types" && label.subject.kind === "message")
  );

  const counts = new Map<string, Omit<FactTypeMetrics, "type" | "precision" | "recall">>();
  const countsFor = (type: string) => {
    const held = counts.get(type);
    if (held !== undefined) return held;
    const made = { labelledPositives: 0, randomPositives: 0, hits: 0, predicted: 0, correct: 0 };
    counts.set(type, made);
    return made;
  };
  for (const type of FACT_TYPES) countsFor(type);

  let labelled = 0;
  let scored = 0;
  let unreadable = 0;
  let notReached = 0;
  let emptyRandom = 0;
  let flaggedRandom = 0;
  let emptyAll = 0;
  let flaggedAll = 0;

  for (const [key, label] of latest) {
    labelled += 1;
    const truth = typesOf(label.answer);
    if (truth === null) {
      unreadable += 1;
      continue;
    }
    const wrote = predicted.get(label.subject.id) ?? new Set<string>();
    if (wrote.size === 0 && !reached.has(label.subject.id)) {
      notReached += 1;
      continue;
    }
    scored += 1;
    const random = firstSlice.get(key)?.slice === "random";
    if (truth.size === 0) {
      emptyAll += 1;
      if (wrote.size > 0) flaggedAll += 1;
      if (random) {
        emptyRandom += 1;
        if (wrote.size > 0) flaggedRandom += 1;
      }
    }
    for (const type of truth) {
      const c = countsFor(type);
      c.labelledPositives += 1;
      if (random) {
        c.randomPositives += 1;
        if (wrote.has(type)) c.hits += 1;
      }
    }
    for (const type of wrote) {
      const c = countsFor(type);
      c.predicted += 1;
      if (truth.has(type)) c.correct += 1;
    }
  }

  return {
    labelledMessages: labelled,
    scored,
    notReached,
    unreadable,
    types: [...counts]
      .sort(([a], [b]) => byText(a, b))
      .map(([type, c]) => ({
        type,
        ...c,
        precision: rate(c.correct, c.predicted),
        recall: rate(c.hits, c.randomPositives)
      })),
    falseAlarms: {
      labelledEmpty: emptyRandom,
      flagged: flaggedRandom,
      rate: rate(flaggedRandom, emptyRandom),
      allSlices: { labelledEmpty: emptyAll, flagged: flaggedAll }
    }
  };
}

const BOOKKEEPING = new Set(["source_event_id", "fact_id", "extractor", "extractor_version"]);

function overlap(a: FactSpan, b: FactSpan): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

const validSpan = (span: FactSpan | null | undefined): span is FactSpan =>
  span !== null &&
  span !== undefined &&
  Number.isFinite(span.start) &&
  Number.isFinite(span.end) &&
  span.end > span.start;

/**
 * A candidate matches a labelled fact when their overlap is at least this fraction of the shorter span. Containment, not
 * intersection over union: a model's quote moves with its wording (it may keep the clause and drop the sentence), so a
 * quote inside the labelled one is the same fact, while a touch of a few code points on a long span is not.
 */
export const MIN_OVERLAP_OF_SHORTER = 0.25;
const ASSIGN_LIMIT = 12;

/**
 * The one-to-one pairing of references with candidates that maximises the total overlap (then the most pairs, then the
 * lowest ids). Exact by search when small; past `ASSIGN_LIMIT` on either side it takes the biggest overlaps first.
 */
function assign<R, C>(refs: readonly R[], cands: readonly C[], weight: (r: R, c: C) => number): [R, C][] {
  if (refs.length > ASSIGN_LIMIT || cands.length > ASSIGN_LIMIT) {
    const edges = refs.flatMap((r, i) => cands.map((c, j) => ({ r, c, i, j, w: weight(r, c) }))).filter((e) => e.w > 0);
    edges.sort((a, b) => b.w - a.w || a.i - b.i || a.j - b.j);
    const usedR = new Set<number>();
    const usedC = new Set<number>();
    const out: [R, C][] = [];
    for (const e of edges) {
      if (usedR.has(e.i) || usedC.has(e.j)) continue;
      usedR.add(e.i);
      usedC.add(e.j);
      out.push([e.r, e.c]);
    }
    return out;
  }
  // Best completion from reference i with the candidates in `used` taken, memoised on (i, used): at most
  // refs x 2^cands states, so the limit above stays fast even when every span overlaps every other.
  interface Best {
    total: number;
    count: number;
    pick: number; // candidate taken by reference i, or -1 to leave it unmatched
  }
  const memo = new Map<number, Best>();
  const solve = (i: number, used: number): Best => {
    if (i === refs.length) return { total: 0, count: 0, pick: -1 };
    const key = i * (1 << cands.length) + used;
    const held = memo.get(key);
    if (held !== undefined) return held;
    let best: Best = { ...solve(i + 1, used), pick: -1 };
    for (let j = 0; j < cands.length; j++) {
      const w = weight(refs[i]!, cands[j]!);
      if ((used & (1 << j)) !== 0 || w <= 0) continue;
      const rest = solve(i + 1, used | (1 << j));
      const total = rest.total + w;
      const count = rest.count + 1;
      if (total > best.total || (total === best.total && count > best.count)) best = { total, count, pick: j };
    }
    memo.set(key, best);
    return best;
  };
  const pairs: [R, C][] = [];
  let used = 0;
  for (let i = 0; i < refs.length; i++) {
    const { pick } = solve(i, used);
    if (pick >= 0) {
      pairs.push([refs[i]!, cands[pick]!]);
      used |= 1 << pick;
    }
  }
  return pairs;
}

/**
 * Predictions for labelled facts the version wrote under a different id. A reference whose own id the version wrote is
 * left to the exact join, and its row is not available to any other reference. Each other reference takes the
 * candidate row about the same message by the pairing with the most total overlap (one row per reference and one
 * reference per row), counting a pair only when the overlap is at least `MIN_OVERLAP_OF_SHORTER` of the shorter span. A row or reference with no span is never matched: guessing would score a different fact.
 * The prediction carries the row's attrs (not its bookkeeping) under the labelled fact's id.
 */
export function fallbackFactPredictions(
  rows: readonly FactRow[],
  references: readonly FactReference[]
): { predictions: EvalPrediction[]; matched: number; unmatched: number } {
  const ownIds = new Set(rows.map((row) => row.factId));
  const wanted = new Set(references.map((reference) => reference.factId));
  const open = references.filter((reference) => !ownIds.has(reference.factId));
  const spare = rows.filter((row) => !wanted.has(row.factId));

  // Group by message: candidate lists are tiny, so each message is solved exactly.
  const byMessage = new Map<string, FactReference[]>();
  for (const reference of open)
    if (validSpan(reference.span))
      byMessage.set(reference.messageId, [...(byMessage.get(reference.messageId) ?? []), reference]);

  const usedReferences = new Set<string>();
  const predictions: EvalPrediction[] = [];
  for (const [messageId, group] of [...byMessage].sort(([a], [b]) => byText(a, b))) {
    const refs = group.sort((a, b) => byText(a.factId, b.factId));
    const cands = spare
      .filter((row) => row.messageId === messageId && validSpan(row.span))
      .sort((a, b) => byText(a.factId, b.factId));
    const weight = (reference: FactReference, row: FactRow): number => {
      const size = overlap(reference.span!, row.span!);
      const shorter = Math.min(reference.span!.end - reference.span!.start, row.span!.end - row.span!.start);
      return size > 0 && size / shorter >= MIN_OVERLAP_OF_SHORTER ? size : 0;
    };
    for (const [reference, row] of assign(refs, cands, weight)) {
      usedReferences.add(reference.factId);
      const attrs = { fact_type: row.factType, ...row.attrs };
      for (const [field, value] of Object.entries(attrs).sort(([a], [b]) => byText(a, b)))
        if (!BOOKKEEPING.has(field))
          predictions.push({ subject: { kind: "fact", id: reference.factId }, field, value });
    }
  }
  const seen = new Set(open.map((reference) => reference.factId));
  return { predictions, matched: usedReferences.size, unmatched: seen.size - usedReferences.size };
}
