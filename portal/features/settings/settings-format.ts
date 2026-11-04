import type { EnergyLevel } from "@/state/portal-state";

export const energyLevels: EnergyLevel[] = ["high", "medium", "low", "recovery"];

export function energyLabel(level: EnergyLevel) {
  return level === "high"
    ? "High focus"
    : level === "medium"
      ? "Medium focus"
      : level === "low"
        ? "Low focus"
        : "Recovery";
}

/** The comma-or-space list of estimate buckets typed into the form, read back as minutes. */
export function parseEstimateBuckets(value: string): number[] {
  return value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
}
