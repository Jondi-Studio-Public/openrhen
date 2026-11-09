/**
 * The evaluation of drift flags: did a flag come two to five minutes before a pinned drift, how many false alarms per
 * waking day, and is that better than flagging at random at the same alarm budget. Pure: rows in, a report out, with
 * a seeded bootstrap so the same input gives the same interval. See docs/architecture/drift.md.
 */
import type { DriftEpisode } from "./drift-episodes.js";
import { DRIFT_RULE_IDS, scorableTypes, type DriftRuleId } from "./drift-rules.js";

/** Every evaluation constant, frozen. */
export const DRIFT_EVAL = Object.freeze({
  horizonMinutes: 5,
  leadMinMinutes: 2,
  /** Fewer scorable pinned drifts than this in the scored subset: no claim. */
  notTestableFloor: 30,
  /** Drifts starting this soon after a switch are not scored. */
  postSwitchMinutes: 5,
  bootstrapResamples: 2000,
  bootstrapSeed: 20261109,
  trainFraction: 0.6
});

const MINUTE = 60_000;

export interface EvalFlag {
  rule: DriftRuleId;
  at: Date;
  momentId: string;
  /** Recorded holdout assignment; carried through, never used to subset. */
  holdout?: boolean;
}

export interface WakingDay {
  /** `YYYY-MM-DD` in the person's zone. */
  day: string;
  /** Capture was off all day: reported apart and left out of the rates. */
  captureOff?: boolean;
}

export interface EvalInput {
  flags: readonly EvalFlag[];
  episodes: readonly DriftEpisode[];
  days: readonly WakingDay[];
  /** Maps an instant to its day key. Defaults to the UTC date. */
  dayOf?: (at: Date) => string;
  /** Item and app switches, for the post-switch exclusion. */
  switches?: readonly Date[];
  /** Flag-eligible moments, the pool the baseline draws from. */
  eligibleMoments?: readonly Date[];
  /** Score only the part after a chronological cut with an embargo (threshold tuning uses the part before). */
  split?: { trainFraction: number } | null;
}

export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** A flag is a hit for an episode when the episode starts in [lead min, horizon] after it. */
export function isHit(flag: Pick<EvalFlag, "at">, episode: DriftEpisode): boolean {
  const delta = episode.occurredAt.getTime() - flag.at.getTime();
  return delta >= DRIFT_EVAL.leadMinMinutes * MINUTE && delta <= DRIFT_EVAL.horizonMinutes * MINUTE;
}

/** Seeded generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ChronologicalSplit<T> {
  train: T[];
  /** Dropped: items within one horizon after the cut, so nothing straddles it. */
  embargoed: T[];
  test: T[];
}

/** Split by time, no shuffle: the first `trainFraction` of the span trains, one horizon is embargoed, the rest tests. */
export function chronologicalSplit<T>(
  items: readonly T[],
  timeOf: (item: T) => Date,
  trainFraction: number = DRIFT_EVAL.trainFraction
): ChronologicalSplit<T> {
  const out: ChronologicalSplit<T> = { train: [], embargoed: [], test: [] };
  if (items.length === 0) return out;
  const times = items.map((item) => timeOf(item).getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  const cut = min + (max - min) * trainFraction;
  const embargoEnd = cut + DRIFT_EVAL.horizonMinutes * MINUTE;
  items.forEach((item, index) => {
    const t = times[index] ?? 0;
    if (t < cut) out.train.push(item);
    else if (t < embargoEnd) out.embargoed.push(item);
    else out.test.push(item);
  });
  return out;
}

interface DayCounts {
  flags: number;
  falseAlarms: number;
  scored: number;
  caught: number;
}

export interface Interval {
  low: number;
  high: number;
}

export interface RuleEval {
  rule: DriftRuleId;
  scoredTypes: string[];
  flags: number;
  hits: number;
  falseAlarms: number;
  falseAlarmsPerDay: number | null;
  /** Scorable pinned drifts in the scored subset (after the post-switch exclusion). */
  scoredDrifts: number;
  caught: number;
  recall: number | null;
  /** True below the floor: no claim is made. */
  notTestable: boolean;
  recallInterval: Interval | null;
  falseAlarmInterval: Interval | null;
  baseline: { flags: number; recall: number | null; falseAlarmsPerDay: number | null } | null;
  /** Recall minus the baseline's, at the same alarm budget. */
  lift: number | null;
}

export interface DriftEvalReport {
  rules: RuleEval[];
  wakingDays: number;
  /** Days with capture off, left out of the rates. */
  captureOffDays: number;
  /** Flags per recorded holdout arm; reported, not used to subset. */
  holdout: { assigned: number; of: number };
  coverage: { pinnedScorable: number; lostToSwitchWindow: number };
  split: { trainFlags: number; embargoedFlags: number; testFlags: number } | null;
}

function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

function interval(values: number[]): Interval | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { low: quantile(sorted, 0.025), high: quantile(sorted, 0.975) };
}

function nearSwitch(episode: DriftEpisode, switches: readonly Date[]): boolean {
  const t = episode.occurredAt.getTime();
  return switches.some((s) => {
    const delta = t - s.getTime();
    return delta >= 0 && delta < DRIFT_EVAL.postSwitchMinutes * MINUTE;
  });
}

function countByDay(
  flags: readonly Pick<EvalFlag, "at">[],
  episodes: readonly DriftEpisode[],
  dayOf: (at: Date) => string,
  dayKeys: ReadonlySet<string>
): Map<string, DayCounts> {
  const days = new Map<string, DayCounts>();
  for (const key of dayKeys) days.set(key, { flags: 0, falseAlarms: 0, scored: 0, caught: 0 });
  for (const flag of flags) {
    const bucket = days.get(dayOf(flag.at));
    if (!bucket) continue;
    bucket.flags += 1;
    if (!episodes.some((episode) => isHit(flag, episode))) bucket.falseAlarms += 1;
  }
  for (const episode of episodes) {
    const bucket = days.get(dayOf(episode.occurredAt));
    if (!bucket) continue;
    bucket.scored += 1;
    if (flags.some((flag) => isHit(flag, episode))) bucket.caught += 1;
  }
  return days;
}

function rates(days: Iterable<DayCounts>): { recall: number | null; fa: number | null } {
  let scored = 0;
  let caught = 0;
  let falseAlarms = 0;
  let n = 0;
  for (const day of days) {
    scored += day.scored;
    caught += day.caught;
    falseAlarms += day.falseAlarms;
    n += 1;
  }
  return { recall: scored > 0 ? caught / scored : null, fa: n > 0 ? falseAlarms / n : null };
}

/** Resample whole days with a fixed seed. The threshold is fixed: nothing is refit inside a resample. */
export function bootstrapByDay(
  days: readonly DayCounts[],
  resamples: number = DRIFT_EVAL.bootstrapResamples,
  seed: number = DRIFT_EVAL.bootstrapSeed
): { recall: Interval | null; falseAlarms: Interval | null } {
  if (days.length === 0) return { recall: null, falseAlarms: null };
  const random = seededRandom(seed);
  const recalls: number[] = [];
  const alarms: number[] = [];
  for (let r = 0; r < resamples; r += 1) {
    const drawn: DayCounts[] = [];
    for (let i = 0; i < days.length; i += 1) drawn.push(days[Math.floor(random() * days.length)] as DayCounts);
    const { recall, fa } = rates(drawn);
    if (recall !== null) recalls.push(recall);
    if (fa !== null) alarms.push(fa);
  }
  return { recall: interval(recalls), falseAlarms: interval(alarms) };
}

/** The trivial comparison: the same number of flags at moments drawn at random from the eligible pool. */
export function baselineFlags(pool: readonly Date[], count: number, seed: number = DRIFT_EVAL.bootstrapSeed): Date[] {
  const left = [...pool];
  const random = seededRandom(seed);
  const out: Date[] = [];
  while (out.length < count && left.length > 0) {
    out.push(left.splice(Math.floor(random() * left.length), 1)[0] as Date);
  }
  return out;
}

/** Score the flags per rule. In shadow every flag is in the arm `shadow` and every drift is scored. */
export function buildDriftEvalReport(input: EvalInput): DriftEvalReport {
  const dayOf = input.dayOf ?? utcDay;
  const switches = input.switches ?? [];
  let eligibleMoments = input.eligibleMoments;
  let inputDays = input.days;

  let flags = [...input.flags];
  let split: DriftEvalReport["split"] = null;
  let episodes = [...input.episodes];
  if (input.split) {
    const parts = chronologicalSplit(flags, (f) => f.at, input.split.trainFraction);
    split = { trainFlags: parts.train.length, embargoedFlags: parts.embargoed.length, testFlags: parts.test.length };
    const first = parts.test[0]?.at.getTime() ?? Number.POSITIVE_INFINITY;
    flags = parts.test;
    episodes = episodes.filter((e) => e.occurredAt.getTime() >= first);
    // Days and the baseline pool cover the scored (test) part only.
    const firstDay = Number.isFinite(first) ? dayOf(new Date(first)) : null;
    inputDays = firstDay === null ? [] : inputDays.filter((d) => d.day >= firstDay);
    eligibleMoments = eligibleMoments?.filter((m) => m.getTime() >= first);
  }
  const live = inputDays.filter((d) => !d.captureOff);
  const dayKeys = new Set(live.map((d) => d.day));
  const captureOffDays = inputDays.length - live.length;

  const pinned = episodes.filter((e) => e.pinned);
  const rules = [...DRIFT_RULE_IDS].sort() as DriftRuleId[];
  let lost = 0;
  let pinnedScorable = 0;
  const perRule = rules.map((rule): RuleEval => {
    const types = new Set<string>(scorableTypes(rule));
    const scorable = pinned.filter((e) => types.has(e.type));
    const scored = scorable.filter((e) => !nearSwitch(e, switches));
    pinnedScorable = Math.max(pinnedScorable, scorable.length);
    lost = Math.max(lost, scorable.length - scored.length);
    const own = flags.filter((f) => f.rule === rule);
    const counts = countByDay(own, scored, dayOf, dayKeys);
    const overall = rates(counts.values());
    const hits = own.filter((f) => scored.some((e) => isHit(f, e))).length;
    const falseAlarms = [...counts.values()].reduce((sum, d) => sum + d.falseAlarms, 0);
    const caught = [...counts.values()].reduce((sum, d) => sum + d.caught, 0);
    const notTestable = scored.length < DRIFT_EVAL.notTestableFloor;
    const boot = bootstrapByDay([...counts.values()]);

    let baseline: RuleEval["baseline"] = null;
    if (eligibleMoments && eligibleMoments.length > 0) {
      const drawn = baselineFlags(eligibleMoments, own.length).map((at) => ({ at }));
      const baseCounts = countByDay(drawn, scored, dayOf, dayKeys);
      const base = rates(baseCounts.values());
      baseline = { flags: drawn.length, recall: base.recall, falseAlarmsPerDay: base.fa };
    }
    const recall = overall.recall;
    return {
      rule,
      scoredTypes: [...types],
      flags: own.length,
      hits,
      falseAlarms,
      falseAlarmsPerDay: overall.fa,
      scoredDrifts: scored.length,
      caught,
      recall,
      notTestable,
      recallInterval: notTestable ? null : boot.recall,
      falseAlarmInterval: notTestable ? null : boot.falseAlarms,
      baseline,
      lift: recall !== null && baseline?.recall != null ? recall - baseline.recall : null
    };
  });

  return {
    rules: perRule,
    wakingDays: live.length,
    captureOffDays,
    holdout: { assigned: flags.filter((f) => f.holdout === true).length, of: flags.length },
    coverage: { pinnedScorable, lostToSwitchWindow: lost },
    split
  };
}
