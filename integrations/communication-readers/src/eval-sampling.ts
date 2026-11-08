/**
 * Picks which messages the person is asked to label. Two draws, both deterministic for a seed so a labelling session
 * can be reproduced and a later run does not quietly pick different messages:
 *   - the random slice: uniform over EVERY candidate, labelled or not. It is the only sample that can measure recall,
 *     because the stratified draw oversamples what the extractor already flags. A message already labelled stays
 *     eligible (dropping it would make the slice depend on what was labelled earlier, which is not uniform); its
 *     existing label is accepted, and `randomToLabel` lists the drawn messages that still need one;
 *   - the stratified draw: up to `perStratum` unlabelled candidates from each stratum (a T0 flag, a keyword hit, ...),
 *     taken from what the random slice left, so no message is asked twice.
 * Candidates are sorted by id first, so the order they arrive in never changes the draw. Pure: no clock, no I/O.
 */

export interface SampleCandidate {
  id: string;
  /** One stratum per candidate (the caller decides which flag wins), such as "t0_flag", "keyword" or "other". */
  stratum: string;
}

export interface SampleRequest {
  candidates: readonly SampleCandidate[];
  /** Candidates to draw from each stratum. */
  perStratum: number;
  /** Size of the random recall slice. */
  randomSize: number;
  /** Any non-empty text; the same seed and candidates give the same draw. */
  seed: string;
  /** Ids already labelled; never drawn again. */
  alreadyLabelled?: readonly string[] | undefined;
}

export interface SamplePlan {
  /** The random recall slice, drawn over all candidates. */
  random: string[];
  /** The part of `random` with no label yet: what the person is asked. */
  randomToLabel: string[];
  /** Sorted by stratum name. */
  stratified: { stratum: string; ids: string[] }[];
  /** Where a draw had fewer candidates than asked for ("random" names the random slice). */
  shortfalls: { stratum: string; wanted: number; got: number }[];
}

/** FNV-1a, 32 bits: turns the seed text into the generator's start state. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: a small seeded generator returning numbers in [0, 1). */
function generator(seed: string): () => number {
  let state = hash32(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const out = [...items];
  const next = generator(seed);
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

const wholeNumber = (value: number) => Number.isInteger(value) && value >= 0;

export function drawSample(request: SampleRequest): SamplePlan {
  const { perStratum, randomSize, seed } = request;
  if (!wholeNumber(perStratum))
    throw new Error(
      `perStratum ${perStratum} is not a whole number of 0 or more. Pass how many to draw from each stratum.`
    );
  if (!wholeNumber(randomSize))
    throw new Error(
      `randomSize ${randomSize} is not a whole number of 0 or more. Pass the size of the random recall slice.`
    );
  if (seed === "")
    throw new Error(
      'seed is empty. Pass any non-empty text, such as "2026-11-08-batch-1", so the draw can be reproduced.'
    );
  const seen = new Set<string>();
  for (const candidate of request.candidates) {
    if (seen.has(candidate.id))
      throw new Error(
        `Candidate id "${candidate.id}" is listed more than once. Pass each message once, with one stratum.`
      );
    seen.add(candidate.id);
  }
  const labelled = new Set(request.alreadyLabelled ?? []);
  const everyone = [...request.candidates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const eligible = everyone.filter((candidate) => !labelled.has(candidate.id));

  const shortfalls: SamplePlan["shortfalls"] = [];
  const random = shuffled(everyone, `${seed}|random`).slice(0, randomSize);
  if (random.length < randomSize) shortfalls.push({ stratum: "random", wanted: randomSize, got: random.length });
  const taken = new Set(random.map((candidate) => candidate.id));

  const strata = [...new Set(eligible.map((candidate) => candidate.stratum))].sort();
  const stratified = strata.map((stratum) => {
    const pool = eligible.filter((candidate) => candidate.stratum === stratum && !taken.has(candidate.id));
    const ids = shuffled(pool, `${seed}|stratum|${stratum}`)
      .slice(0, perStratum)
      .map((candidate) => candidate.id);
    if (ids.length < perStratum) shortfalls.push({ stratum, wanted: perStratum, got: ids.length });
    return { stratum, ids };
  });
  return {
    random: random.map((candidate) => candidate.id),
    randomToLabel: random.filter((candidate) => !labelled.has(candidate.id)).map((candidate) => candidate.id),
    stratified,
    shortfalls
  };
}
