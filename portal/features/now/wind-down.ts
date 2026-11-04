const WIND_DOWN_LEAD_MS = 2 * 60 * 60 * 1000;

// The "Start winding down for bed now" choice is only worth offering near bedtime: from two hours
// before the sleep plan's planned start, with no upper bound (the plan itself ends the window).
export function windDownOffered(plannedStartAt: string, now: Date): boolean {
  const start = new Date(plannedStartAt).getTime();
  if (Number.isNaN(start)) return false;
  return now.getTime() >= start - WIND_DOWN_LEAD_MS;
}
