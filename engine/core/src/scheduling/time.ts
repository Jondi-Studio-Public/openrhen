import { ARRIVAL_MARGIN_MINUTES, commitmentProtection } from "../model/types.js";
import type { CapacityEnergy, CapacityWindow, FixedCommitment, TimeRange } from "../model/types.js";
import type { EnergyType } from "@openrhen/contracts";

const MINUTE_MS = 60_000;

export function minutesBetween(start: Date, end: Date): number {
  return Math.max(0, Math.floor((end.getTime() - start.getTime()) / MINUTE_MS));
}

export function overlap(a: TimeRange, b: TimeRange): TimeRange | null {
  const startsAt = new Date(Math.max(a.startsAt.getTime(), b.startsAt.getTime()));
  const endsAt = new Date(Math.min(a.endsAt.getTime(), b.endsAt.getTime()));
  return startsAt < endsAt ? { startsAt, endsAt } : null;
}

export function mergeRanges(ranges: TimeRange[]): TimeRange[] {
  const sorted = [...ranges].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const merged: TimeRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (!last || range.startsAt > last.endsAt) {
      merged.push({ ...range });
    } else if (range.endsAt > last.endsAt) {
      last.endsAt = range.endsAt;
    }
  }
  return merged;
}

export function energyCompatible(required: EnergyType, available: CapacityEnergy): boolean {
  if (available === "unconfirmed") return true;
  if (required === "recovery") return available === "recovery";
  if (available === "recovery") return false;
  const rank: Record<Exclude<EnergyType, "recovery">, number> = { low: 1, medium: 2, high: 3 };
  return rank[available] >= rank[required];
}

export function compatibleCapacityMinutes(args: {
  from: Date;
  until: Date;
  requiredEnergy: EnergyType;
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  arrivalMarginMinutes?: number;
}): number {
  const arrivalMarginMinutes = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const horizon = { startsAt: args.from, endsAt: args.until };
  let total = 0;

  for (const window of args.capacityWindows) {
    if (!energyCompatible(args.requiredEnergy, window.energy)) continue;
    const usableWindow = overlap(window, horizon);
    if (!usableWindow) continue;

    const blocked = mergeRanges(
      args.commitments
        .map((commitment) => overlap(commitmentProtection(commitment, arrivalMarginMinutes), usableWindow))
        .filter((value): value is TimeRange => value !== null)
    );

    const raw = minutesBetween(usableWindow.startsAt, usableWindow.endsAt);
    const blockedMinutes = blocked.reduce((sum, range) => sum + minutesBetween(range.startsAt, range.endsAt), 0);
    total += Math.floor(Math.max(0, raw - blockedMinutes) * window.usableFraction);
  }

  return total;
}

export function nextAvailableWindowMinutes(args: {
  now: Date;
  requiredEnergy: EnergyType;
  capacityWindows: CapacityWindow[];
  commitments: FixedCommitment[];
  horizonEnd: Date;
  arrivalMarginMinutes?: number;
}): number {
  const arrivalMarginMinutes = args.arrivalMarginMinutes ?? ARRIVAL_MARGIN_MINUTES;
  const containing = args.capacityWindows
    .filter(
      (window) =>
        energyCompatible(args.requiredEnergy, window.energy) && window.startsAt <= args.now && window.endsAt > args.now
    )
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime())[0];

  if (!containing) return 0;
  let end = new Date(Math.min(containing.endsAt.getTime(), args.horizonEnd.getTime()));
  for (const commitment of args.commitments) {
    const blockedStart = commitmentProtection(commitment, arrivalMarginMinutes).startsAt;
    if (blockedStart > args.now && blockedStart < end) end = blockedStart;
    if (commitment.startsAt <= args.now && commitment.endsAt > args.now) return 0;
  }
  return Math.floor(minutesBetween(args.now, end) * containing.usableFraction);
}
