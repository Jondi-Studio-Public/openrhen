/** Conversions from database column values to the shapes the stored portal state uses. */

export function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return new Date(value).toISOString();
}

export function numberOr(value: string | number | null | undefined, fallback: number): number {
  return value === null || value === undefined ? fallback : Number(value);
}

export function localDateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

/**
 * The comparison-derived consequence of a project or action row as the state fields. Both fields or neither: a value
 * outside 0..6 or not finite, stars outside 1..5, or either half missing reads as no value (today's behaviour). The
 * engine separately ignores a value fitted for different stars than the row now has.
 */
export function refinedConsequenceFields(row: {
  consequence_refined: number | string | null;
  consequence_refined_for_stars: number | string | null;
}): { consequenceRefined?: number; consequenceRefinedForStars?: number } {
  if (row.consequence_refined === null || row.consequence_refined_for_stars === null) return {};
  const value = Number(row.consequence_refined);
  const stars = Number(row.consequence_refined_for_stars);
  if (!Number.isFinite(value) || value < 0 || value > 6) return {};
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return {};
  return { consequenceRefined: Math.round(value * 100) / 100, consequenceRefinedForStars: stars };
}
