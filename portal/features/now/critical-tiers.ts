/**
 * The engine's deadline-critical ladder, named (logic-design §9). The portal cannot import
 * engine-core, so the names and their short labels are restated here; the order is the engine's and
 * is not used for ranking on this side — only for reading a stored result.
 */
export type CriticalTier =
  | "overdue_external"
  | "behind_external"
  | "at_risk_external"
  | "behind_internal"
  | "at_risk_internal"
  | "due_this_week_external"
  | "ordinary"
  | "stale_date";

/** Short labels for a pill next to the recommendation; the engine's own wording travels in `why`. */
export const CRITICAL_TIER_LABELS: Record<CriticalTier, string> = {
  overdue_external: "Overdue · external deadline",
  behind_external: "Behind · external deadline",
  at_risk_external: "At risk · external deadline",
  behind_internal: "Behind · self-set deadline",
  at_risk_internal: "At risk · self-set deadline",
  due_this_week_external: "External deadline this week",
  stale_date: "Self-set date lapsed · still wanted?",
  ordinary: "Ordinary ranking"
};

/** Reads a tier out of a stored result; anything unrecognised (or absent) is treated as ordinary. */
export function criticalTierLabel(tier: string | undefined | null): string | null {
  if (!tier || tier === "ordinary") return null;
  // Results stored before the stale-date tier carry its old name.
  if (tier === "renegotiate") return CRITICAL_TIER_LABELS.stale_date;
  return tier in CRITICAL_TIER_LABELS ? CRITICAL_TIER_LABELS[tier as CriticalTier] : null;
}
