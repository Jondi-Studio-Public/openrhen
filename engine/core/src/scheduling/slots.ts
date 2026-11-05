import {
  evaluateConditions,
  parseRequirementKey,
  type ConditionDefinition,
  type ResolvedSituation,
  type Truth
} from "@openrhen/contracts";
import { ARRIVAL_MARGIN_MINUTES, commitmentProtection } from "../model/types.js";
import type { Action, CapacityWindow, FixedCommitment, PlanningSlot, TimeRange } from "../model/types.js";
import { energyCompatible, mergeRanges, minutesBetween, overlap } from "./time.js";

const MINUTE_MS = 60_000;
const SLOT_MINUTES = 15;
const energyRank: Record<CapacityWindow["energy"], number> = {
  recovery: 0,
  low: 1,
  medium: 2,
  high: 3,
  unconfirmed: 4
};

/**
 * `new Date(ms).toISOString()`, remembered. Every slot is named by its two ends, and the same
 * quarter-hour boundaries recur in every band's ledger, in the raw and the commitment-netted pass over
 * it, and in every re-plan a continuation simulates: formatting them afresh each time was nearly a third
 * of a plan. The string is the one `toISOString` gives, so slot ids are unchanged. Cleared
 * rather than left to grow once it holds far more instants than one request's horizon has.
 */
const isoInstants = new Map<number, string>();
const ISO_INSTANT_LIMIT = 200_000;
function isoInstant(ms: number): string {
  let iso = isoInstants.get(ms);
  if (iso === undefined) {
    iso = new Date(ms).toISOString();
    if (isoInstants.size >= ISO_INSTANT_LIMIT) isoInstants.clear();
    isoInstants.set(ms, iso);
  }
  return iso;
}

export function normalizePlanningSlots(args: {
  from: Date;
  until: Date;
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  boundaries?: Date[];
  arrivalMarginMinutes?: number;
}): PlanningSlot[] {
  if (args.until <= args.from) return [];
  const arrivalMarginMinutes = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const horizon = { startsAt: args.from, endsAt: args.until };
  const windows = args.capacityWindows
    .map((window) => ({ ...window, clipped: overlap(window, horizon) }))
    .filter((entry): entry is typeof entry & { clipped: TimeRange } => entry.clipped !== null);
  const blocked = mergeRanges(
    args.commitments
      .map((commitment) => commitmentProtection(commitment, arrivalMarginMinutes))
      .map((range) => overlap(range, horizon))
      .filter((range): range is TimeRange => range !== null)
  );
  const boundaries = new Set<number>([args.from.getTime(), args.until.getTime()]);
  for (const boundary of args.boundaries ?? [])
    if (boundary > args.from && boundary < args.until) boundaries.add(boundary.getTime());
  for (
    let cursor = args.from.getTime() + SLOT_MINUTES * MINUTE_MS;
    cursor < args.until.getTime();
    cursor += SLOT_MINUTES * MINUTE_MS
  )
    boundaries.add(cursor);
  for (const { clipped } of windows) {
    boundaries.add(clipped.startsAt.getTime());
    boundaries.add(clipped.endsAt.getTime());
  }
  for (const range of blocked) {
    boundaries.add(range.startsAt.getTime());
    boundaries.add(range.endsAt.getTime());
  }
  const points = [...boundaries].sort((a, b) => a - b);
  // Slot ranges advance monotonically, so a window that has already ended can never match a later
  // slot. Walking a cursor through start-sorted windows keeps this linear instead of rescanning
  // every window for every slot, which matters once automatic mode emits one window per day.
  const ordered = [...windows].sort((a, b) => a.clipped.startsAt.getTime() - b.clipped.startsAt.getTime());
  // A window's context set does not change from slot to slot, so it is normalized once per window
  // rather than once per window per slot — the difference between a few hundred sorts and a few
  // million once automatic mode emits a window a day across a six-month horizon. The arrays are
  // shared by the slots that cite them; nothing in the engine mutates a slot's contexts.
  const normalizedContexts = new Map(ordered.map((entry) => [entry, [...new Set(entry.contexts ?? [])].sort()]));
  const noContexts: string[] = [];
  // `mergeRanges` returns disjoint ranges in start order, and slots advance monotonically, so the only
  // blocked range that can still touch a slot is the first one that has not already ended. Rescanning
  // the whole list per slot was the same quadratic trap the window cursor above already avoids, and it
  // bites far harder here: a six-month forecast carries a protected night for every night in it, so
  // tens of thousands of slots were each testing hundreds of ranges.
  const blockedBounds = blocked.map((range) => [range.startsAt.getTime(), range.endsAt.getTime()] as const);
  let blockedCursor = 0;
  let cursor = 0;

  return points.slice(0, -1).map((start, index) => {
    const endsAtMs = points[index + 1]!;
    const range = { startsAt: new Date(start), endsAt: new Date(endsAtMs) };
    while (blockedCursor < blockedBounds.length && blockedBounds[blockedCursor]![1] <= start) blockedCursor += 1;
    const fixed = blockedCursor < blockedBounds.length && blockedBounds[blockedCursor]![0] < endsAtMs;
    while (cursor < ordered.length && ordered[cursor]!.clipped.endsAt.getTime() <= start) cursor += 1;
    const active: typeof ordered = [];
    for (
      let scan = cursor;
      scan < ordered.length && ordered[scan]!.clipped.startsAt.getTime() < range.endsAt.getTime();
      scan += 1
    ) {
      if (ordered[scan]!.clipped.endsAt.getTime() > start) active.push(ordered[scan]!);
    }
    active.sort(
      (a, b) =>
        energyRank[b.energy] - energyRank[a.energy] || b.usableFraction - a.usableFraction || a.id.localeCompare(b.id)
    );
    const chosen = active[0];
    const contexts = chosen ? normalizedContexts.get(chosen)! : noContexts;
    const duration = minutesBetween(range.startsAt, range.endsAt);
    // A slot's remaining minutes mean the most any single compatible action could draw from it: the
    // slot's own capacity ceiling. `chosen` (picked above by energy rank, so the slot's displayed
    // energy and contexts come from the window that admits the most demanding work) is not
    // necessarily the window with the highest usable fraction, so its own fraction is not that
    // ceiling — a low-energy action is compatible with every free window regardless of energy, and a
    // recovery action with every protected one, so each can reach the *best* usable fraction on offer
    // in its category, not just the one the tie-break preferred. `slotCapacityForAction` already
    // maximizes over the options a given action is compatible with; this is that same maximum taken
    // over the most permissive action of `chosen`'s own category (free vs. protected), which is the
    // slot's honest capacity total and what seeds the allocation ledger below. Using `chosen`'s own
    // fraction instead let two overlapping windows disagree with `slotCapacityForAction` about how
    // much of the slot was truly free, silently losing capacity (when the tie-break window offered
    // less than another compatible one) or fabricating it (the reverse) depending only on which window
    // happened to win the tie-break — never on what was physically available.
    const usableFraction = chosen
      ? Math.max(
          ...active
            .filter((entry) => (entry.energy === "recovery") === (chosen.energy === "recovery"))
            .map((entry) => entry.usableFraction)
        )
      : 0;
    const capacityMinutes = fixed ? 0 : duration * usableFraction;
    const availability: PlanningSlot["availability"] = fixed
      ? "fixed"
      : !chosen
        ? "unavailable"
        : chosen.energy === "recovery"
          ? "protected"
          : "free";
    const capacityOptions = fixed
      ? []
      : active.map((entry) => ({
          id: entry.id,
          energy: entry.energy,
          contexts: normalizedContexts.get(entry)!,
          usableFraction: entry.usableFraction,
          availability: entry.energy === "recovery" ? ("protected" as const) : ("free" as const)
        }));
    return {
      id: `slot:${isoInstant(start)}:${isoInstant(endsAtMs)}`,
      ...range,
      availability,
      energy: chosen?.energy ?? "low",
      contexts,
      usableFraction,
      capacityMinutes,
      capacityOptions
    };
  });
}

/** Separators no identifier can contain, so two different sets can never join to the same string. */
const SEPARATOR = "\u0000";
const FIELD_SEPARATOR = "\u0001";

/**
 * Answering "how much of this slot can this action use" is a pure function of the objects handed in,
 * and one plan asks it millions of times: every slot against every action of every project, once for
 * gross capacity, again for available capacity, again for each confidence band, and again while
 * allocating. A six-month horizon is tens of thousands of quarter-hours, and the vast majority of them
 * are indistinguishable — the same window energy, the same declared contexts, the same usable
 * fraction. Caching on what the slot *offers* rather than on which slot it is collapses all of them
 * into a single evaluation.
 *
 * The cached quantity is the usable fraction, not the minutes: the fraction is what the offer and the
 * action decide between them, while the minutes are that fraction times the slot's own length. Keeping
 * the multiplication where it was leaves the arithmetic — and so the bytes of the result —
 * unchanged.
 *
 * Held weakly by action, so a finished request's entries go with it and nothing accumulates between
 * requests. The signatures themselves are per-slot and equally short-lived.
 */
const offerCache = new WeakMap<PlanningSlot, string>();
const admissionCache = new WeakMap<Action, Map<string, boolean>>();
const fractionCache = new WeakMap<Action, Map<string, number>>();

/** Everything about a slot that can change the answer, and nothing that cannot. */
function offerSignature(slot: PlanningSlot): string {
  const cached = offerCache.get(slot);
  if (cached !== undefined) return cached;
  const signature = slot.capacityOptions
    .map(
      (option) =>
        `${option.energy}|${option.availability}|${option.usableFraction}|${option.contexts.join(FIELD_SEPARATOR)}`
    )
    .join(SEPARATOR);
  offerCache.set(slot, signature);
  return signature;
}

/**
 * A capacity window describes a hypothetical future situation, not the present one, so it is resolved
 * against what the window itself declares rather than against where the person is now.
 *
 * Unknown is permissive here, deliberately. A window that declares no contexts says nothing about
 * what will be available, and treating silence as refusal would empty the forecast; a window that
 * does declare contexts is taken as a complete statement, so anything it omits is genuinely absent.
 * That is exactly the arithmetic this path had before the shared evaluator, now stated rather than
 * emergent — forecasting against typed situations is deferred work.
 */
function windowAdmits(windowContexts: string[], action: Action): boolean {
  const cached = admissionCache.get(action);
  // Slot contexts are deduplicated and sorted where the slot is built, so the joined form is a
  // faithful signature of the set rather than of one particular ordering of it.
  const key = windowContexts.join(SEPARATOR);
  const hit = cached?.get(key);
  if (hit !== undefined) return hit;
  const answer = evaluateAdmission(windowContexts, action);
  if (cached) cached.set(key, answer);
  else admissionCache.set(action, new Map([[key, answer]]));
  return answer;
}

function evaluateAdmission(windowContexts: string[], action: Action): boolean {
  const pathways =
    action.requirementPathways ??
    (action.contexts.length ? [{ id: `${action.id}:legacy`, contextIds: action.contexts }] : []);
  if (!pathways.length) return true;
  const declared = new Set(windowContexts);
  const resolve = (contextId: string): Truth => {
    // A window declares contexts, never who will be with the owner, so `pete@with` and `pete@remote` are judged
    // as `pete` always was. Whether Pete is actually here is settled against the present, not a window.
    const { id } = parseRequirementKey(contextId);
    return declared.has(id) ? "yes" : declared.size ? "no" : "unknown";
  };
  const resolved: ResolvedSituation = {
    locationId: null,
    locationStale: false,
    cycles: [],
    resolve,
    definitionOf: (): ConditionDefinition | undefined => undefined
  };
  return evaluateConditions({ pathways, resolved }).status !== "no";
}

export function slotFitsAction(slot: PlanningSlot, action: Action): boolean {
  return slotCapacityForAction(slot, action) > 0;
}

export function slotCapacityForAction(slot: PlanningSlot, action: Action): number {
  if (slot.availability === "fixed" || slot.availability === "unavailable") return 0;
  return minutesBetween(slot.startsAt, slot.endsAt) * usableFractionForAction(slot, action);
}

export function usableFractionForAction(slot: PlanningSlot, action: Action): number {
  const signature = offerSignature(slot);
  const cached = fractionCache.get(action);
  const hit = cached?.get(signature);
  if (hit !== undefined) return hit;
  const options = slot.capacityOptions.filter((option) => {
    if (!energyCompatible(action.energy, option.energy)) return false;
    if (action.energy !== "recovery" && option.availability !== "free") return false;
    if (action.energy === "recovery" && option.availability !== "protected") return false;
    return windowAdmits(option.contexts, action);
  });
  const usableFraction = Math.max(0, ...options.map((option) => option.usableFraction));
  if (cached) cached.set(signature, usableFraction);
  else fractionCache.set(action, new Map([[signature, usableFraction]]));
  return usableFraction;
}

/**
 * A slot array restated for a walk that asks every slot the same question many times over: each slot's
 * start, its whole minutes, and an index shared by every slot with the same offer — or -1 where the slot
 * offers nothing to any action (fixed or unavailable). `representatives[offer]` is the first slot with
 * that offer. Since `usableFractionForAction` is a function of the offer and the action alone, asking it
 * of the representative answers for every slot sharing the index.
 */
export interface SlotOfferIndex {
  starts: Float64Array;
  minutes: Float64Array;
  offer: Int32Array;
  representatives: PlanningSlot[];
}
export function indexSlotOffers(slots: PlanningSlot[]): SlotOfferIndex {
  const starts = new Float64Array(slots.length);
  const minutes = new Float64Array(slots.length);
  const offer = new Int32Array(slots.length);
  const representatives: PlanningSlot[] = [];
  const bySignature = new Map<string, number>();
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index]!;
    starts[index] = slot.startsAt.getTime();
    minutes[index] = minutesBetween(slot.startsAt, slot.endsAt);
    if (slot.availability === "fixed" || slot.availability === "unavailable") {
      offer[index] = -1;
      continue;
    }
    const signature = offerSignature(slot);
    let shared = bySignature.get(signature);
    if (shared === undefined) {
      shared = representatives.length;
      bySignature.set(signature, shared);
      representatives.push(slot);
    }
    offer[index] = shared;
  }
  return { starts, minutes, offer, representatives };
}

/**
 * Whether a slot array's starts run in non-decreasing order, which every plan's slots do. It lets
 * `currentCompatibleWindow` stop looking once slots start past the point that matters, where it used
 * to filter the whole horizon for every action a ranking scored. The same slots are tested
 * in the same order either way; ordering only lets it skip ones that could not have passed. Worked out
 * once per array and held weakly, so it goes with the plan that built the array, and rechecked if the
 * array's length changes. Nothing in the engine edits a slot once it is built.
 */
const ascendingCache = new WeakMap<PlanningSlot[], { length: number; ascending: boolean }>();
function startsAscend(slots: PlanningSlot[]): boolean {
  const cached = ascendingCache.get(slots);
  if (cached && cached.length === slots.length) return cached.ascending;
  let ascending = true;
  let previous = Number.NEGATIVE_INFINITY;
  for (const slot of slots) {
    const start = slot.startsAt.getTime();
    // Negated so an invalid date (NaN) also counts as out of order.
    if (!(start >= previous)) {
      ascending = false;
      break;
    }
    previous = start;
  }
  ascendingCache.set(slots, { length: slots.length, ascending });
  return ascending;
}

export function currentCompatibleWindow(args: { now: Date; horizonEnd: Date; action: Action; slots: PlanningSlot[] }) {
  const empty = { minutes: 0, energy: null as CapacityWindow["energy"] | null, boundary: args.now };
  // The horizon is a hard bound on the session, so a horizon already in the past offers nothing.
  if (args.horizonEnd <= args.now) return empty;
  const ascending = startsAscend(args.slots);
  let firstIndex = -1;
  for (let index = 0; index < args.slots.length; index += 1) {
    const slot = args.slots[index]!;
    // In ascending slots, nothing after one starting past `now` can contain it.
    if (ascending && slot.startsAt > args.now) break;
    if (slot.startsAt <= args.now && slot.endsAt > args.now && slotFitsAction(slot, args.action)) {
      firstIndex = index;
      break;
    }
  }
  if (firstIndex < 0) return empty;
  const first = args.slots[firstIndex]!;
  const firstCapacity = slotCapacityForAction(first, args.action);
  const firstDuration = minutesBetween(first.startsAt, first.endsAt);
  const firstEnd = new Date(Math.min(first.endsAt.getTime(), args.horizonEnd.getTime()));
  // Not floored here: the partial first slot is summed with whole slots below and the total is
  // floored once, so half a usable minute at the start is not thrown away before it is counted.
  let minutes = minutesBetween(args.now, firstEnd) * (firstDuration > 0 ? firstCapacity / firstDuration : 0);
  let boundary = firstEnd;
  let prior = first;
  // In ascending slots nothing at or before `first` starts after it ends, and nothing after a slot
  // starting at the horizon starts before it, so the walk begins just past `first` and stops there.
  for (let index = ascending ? firstIndex + 1 : 0; index < args.slots.length; index += 1) {
    const slot = args.slots[index]!;
    if (!(slot.startsAt >= first.endsAt && slot.startsAt < args.horizonEnd)) {
      if (ascending && slot.startsAt >= args.horizonEnd) break;
      continue;
    }
    if (slot.startsAt.getTime() !== prior.endsAt.getTime() || !slotFitsAction(slot, args.action)) break;
    // A slot straddling the horizon contributes only the part that falls inside it.
    const end = new Date(Math.min(slot.endsAt.getTime(), args.horizonEnd.getTime()));
    const duration = minutesBetween(slot.startsAt, slot.endsAt);
    const usable = minutesBetween(slot.startsAt, end);
    minutes += slotCapacityForAction(slot, args.action) * (duration > 0 ? usable / duration : 0);
    boundary = end;
    prior = slot;
    if (end.getTime() < slot.endsAt.getTime()) break;
  }
  // Slot capacities are fractions of quarter-hours summed in floating point, so a window that is
  // exactly 30 usable minutes can arrive as 29.999…; flooring that to 29 would understate the session
  // by a minute for no reason a person could see.
  return { minutes: Math.floor(minutes + FLOAT_EPSILON), energy: first.energy, boundary };
}

const FLOAT_EPSILON = 1e-6;
