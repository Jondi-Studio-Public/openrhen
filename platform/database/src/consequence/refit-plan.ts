import { fitConsequence } from "@openrhen/contracts/consequence-fit";
import type { PoolRow } from "./pool-load.js";
import type { UsableComparisons } from "./usable-comparisons.js";

/**
 * What one refit of a pool changes, as a pure function of the rows as stored, the usable comparisons and the day
 * (`refit.ts` does the reading and the writing). An item with a usable comparison gets its fitted value with
 * `for_stars` set to its CURRENT stars and `as_of` set to the day, overwritten on every fit whether or not the value
 * moved; an item without one (including any inactive item) is cleared, all three columns together. A row already
 * holding exactly the target is left out so a quiet refit writes nothing.
 */
export interface RefitWrite {
  id: string;
  value: number;
  stars: number;
}

export interface RefitPlan {
  writes: RefitWrite[];
  clears: string[];
}

export function planRefit(rows: readonly PoolRow[], usable: UsableComparisons, asOfDay: string): RefitPlan {
  const fitted = new Map(
    fitConsequence(
      rows.map((row) => ({ id: row.id, stars: row.stars, status: row.status })),
      usable.comparisons
    ).map((result) => [result.id, result])
  );
  const writes: RefitWrite[] = [];
  const clears: string[] = [];
  for (const row of rows) {
    const result = usable.touchedIds.has(row.id) ? fitted.get(row.id) : undefined;
    const target =
      result && Number.isFinite(result.value) && result.value >= 0 && result.value <= 6
        ? { value: result.value, stars: row.stars }
        : null;
    if (target) {
      const same = row.refined === target.value && row.refinedForStars === target.stars && row.refinedAsOf === asOfDay;
      if (!same) writes.push({ id: row.id, ...target });
    } else if (row.refined !== null || row.refinedForStars !== null || row.refinedAsOf !== null) {
      clears.push(row.id);
    }
  }
  return { writes, clears };
}
