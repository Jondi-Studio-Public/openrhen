import { ageWeight, isConsequenceFitActive, type ConsequenceFitComparison } from "@openrhen/contracts/consequence-fit";

/**
 * Turns the stored comparison log into the weighted comparisons `fitConsequence` takes (comparison-consequence-ranking
 * design, 3.5). Pure: the same items, log and day always give the same result, in the same order.
 *
 * A comparison is dropped whole when any of its still-live items has different stars or a different material-field
 * hash from the one stored with the answer (one rule, so it cannot compound). An item that is no longer live (done,
 * cancelled, archived, deleted or never in this pool) just leaves the comparison, which stays for the rest. The weight
 * is the age weight, taken in whole local calendar days from the answer's local day to `asOfDay`, times the basis
 * weight, with a ceiling (applied newest answer first, so the newest guesses win) on how much inferred (agent-guessed) weight one item can collect per day and in total so that
 * repeated guesses cannot push a value to the fit's bound.
 */

/** Stated and observed answers count in full; an inferred one counts half. */
export const BASIS_WEIGHT = { stated: 1, observed: 1, inferred: 0.5 } as const;
export type ComparisonBasis = keyof typeof BASIS_WEIGHT;

/** The most inferred weight one item can collect from answers given on one local day (one inferred answer at full). */
export const INFERRED_ITEM_DAY_CEILING = 0.5;
/** The most inferred weight one item can hold in total. One stated answer of 1.0 moves an item about 0.57 stars; the bound is 1. */
export const INFERRED_ITEM_TOTAL_CEILING = 1;

/** A live item of the pool as the fit sees it. */
export interface PoolItem {
  id: string;
  stars: number;
  status: string;
  materialHash: string;
}

/** One stored answer. `itemStars` and `itemHashes` run parallel to `itemIds`. */
export interface LoggedComparison {
  id: string;
  itemIds: readonly string[];
  itemStars: readonly number[];
  itemHashes: readonly string[];
  /** Best first; null for a tie. */
  ranking: readonly string[] | null;
  tie: boolean;
  basis: string;
  answeredAt: Date;
}

export type DropReason = "tie" | "stale" | "too_few_items" | "inferred_ceiling" | "aged_out" | "bad_row";

export interface UsableComparisons {
  /** In answer order (oldest first), ready for `fitConsequence`. */
  comparisons: ConsequenceFitComparison[];
  /** Every item that appears in at least one comparison kept. Others have no usable comparison. */
  touchedIds: Set<string>;
  dropped: { id: string; reason: DropReason }[];
}

/** The calendar day (`YYYY-MM-DD`) an instant falls on in a time zone; an unknown zone reads as UTC. */
export function localDay(at: Date, timezone: string): string {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
  } catch {
    format = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" });
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dayNumber(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Math.round(Date.UTC(year!, month! - 1, date!) / 86_400_000);
}

/** Whole calendar days from `fromDay` to `toDay`, never negative. */
export function wholeDaysBetween(fromDay: string, toDay: string): number {
  return Math.max(0, dayNumber(toDay) - dayNumber(fromDay));
}

function basisWeight(basis: string): number {
  return Object.prototype.hasOwnProperty.call(BASIS_WEIGHT, basis) ? BASIS_WEIGHT[basis as ComparisonBasis] : 0;
}

export function usableComparisons(
  items: readonly PoolItem[],
  log: readonly LoggedComparison[],
  asOfDay: string,
  timezone: string
): UsableComparisons {
  const live = new Map<string, PoolItem>();
  for (const item of items) if (isConsequenceFitActive(item.status) && !live.has(item.id)) live.set(item.id, item);

  // Newest first, so when a ceiling bites it is the oldest guesses that are dropped. The output is put back
  // oldest-first below, which keeps the order deterministic.
  const ordered = [...log].sort(
    (a, b) => b.answeredAt.getTime() - a.answeredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
  const usedPerDay = new Map<string, number>();
  const usedTotal = new Map<string, number>();
  const comparisons: ConsequenceFitComparison[] = [];
  const touchedIds = new Set<string>();
  const dropped: UsableComparisons["dropped"] = [];

  for (const entry of ordered) {
    if (entry.tie || !entry.ranking) {
      dropped.push({ id: entry.id, reason: "tie" });
      continue;
    }
    if (entry.itemStars.length !== entry.itemIds.length || entry.itemHashes.length !== entry.itemIds.length) {
      dropped.push({ id: entry.id, reason: "bad_row" });
      continue;
    }
    const stale = entry.itemIds.some((id, index) => {
      const item = live.get(id);
      return (
        item !== undefined && (item.stars !== entry.itemStars[index] || item.materialHash !== entry.itemHashes[index])
      );
    });
    if (stale) {
      dropped.push({ id: entry.id, reason: "stale" });
      continue;
    }
    const rankedIds = entry.ranking.filter((id) => live.has(id));
    if (rankedIds.length < 2) {
      dropped.push({ id: entry.id, reason: "too_few_items" });
      continue;
    }
    const answerDay = localDay(entry.answeredAt, timezone);
    const age = ageWeight(wholeDaysBetween(answerDay, asOfDay));
    let weight = age * basisWeight(entry.basis);
    if (entry.basis === "inferred") {
      const room = Math.min(
        ...rankedIds.map((id) =>
          Math.min(
            INFERRED_ITEM_DAY_CEILING - (usedPerDay.get(`${id}|${answerDay}`) ?? 0),
            INFERRED_ITEM_TOTAL_CEILING - (usedTotal.get(id) ?? 0)
          )
        )
      );
      weight = Math.min(weight, Math.max(0, room));
      if (weight > 0)
        for (const id of rankedIds) {
          usedPerDay.set(`${id}|${answerDay}`, (usedPerDay.get(`${id}|${answerDay}`) ?? 0) + weight);
          usedTotal.set(id, (usedTotal.get(id) ?? 0) + weight);
        }
    }
    if (!(weight > 0)) {
      const reason: DropReason =
        basisWeight(entry.basis) === 0 ? "bad_row" : !(age > 0) ? "aged_out" : "inferred_ceiling";
      dropped.push({ id: entry.id, reason });
      continue;
    }
    comparisons.push({ id: entry.id, rankedIds, weight });
    for (const id of rankedIds) touchedIds.add(id);
  }
  return { comparisons: comparisons.reverse(), touchedIds, dropped: dropped.reverse() };
}
