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
