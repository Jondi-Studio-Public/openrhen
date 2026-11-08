/** Mirrors DERIVED_FACT_STATUSES in platform/contracts (this package imports no workspace package). */
export const FACT_STATUSES = [
  "proposed",
  "confirmed",
  "rescheduled",
  "cancelled",
  "done",
  "superseded",
  "source_gone"
] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** Who made the statement. Rank decides ties: the person over Mark over the extractor. */
export type StatusActor = "person" | "mark" | "extractor";
const ACTOR_RANK: Record<StatusActor, number> = { person: 3, mark: 2, extractor: 1 };

export interface StatusRow {
  status: FactStatus;
  /** RFC 3339: when the status took effect in the world. */
  validFrom: string;
  actor: StatusActor;
  /** The row's event_key; the last tie-break, so the answer never depends on input order. */
  key: string;
  /** A rescheduled row may carry the fact's new end time. */
  expiresAt?: string | null | undefined;
}

export interface ResolvedStatus {
  status: FactStatus | "expired";
  /** The winning row, or null when the fact has none (implicitly proposed). */
  row: StatusRow | null;
  expired: boolean;
}

const OPEN: readonly string[] = ["proposed", "confirmed", "rescheduled"];

/** An open fact is one still waiting on something; `expired` and the closed statuses are not open. */
export function isOpenStatus(status: FactStatus | "expired"): boolean {
  return OPEN.includes(status);
}

const instant = (value: string | null | undefined): number => {
  const ms = value === null || value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
};

/**
 * The current status of one fact, a pure function of its fact_status rows. The latest `valid_from` wins; a tie goes to
 * the higher-ranked actor, then to the greater key. `expired` is computed here at read and never written (the table
 * refuses UPDATE): an open winner whose end time (its own `expiresAt`, else the fact's) has passed is `expired`.
 */
export function resolveFactStatus(
  rows: readonly StatusRow[],
  options: { now: Date; expiresAt?: string | null | undefined }
): ResolvedStatus {
  let winner: StatusRow | null = null;
  for (const candidate of rows) {
    if (winner === null) {
      winner = candidate;
      continue;
    }
    const [a, b] = [instant(candidate.validFrom), instant(winner.validFrom)];
    if (
      a > b ||
      (a === b && ACTOR_RANK[candidate.actor] > ACTOR_RANK[winner.actor]) ||
      (a === b && candidate.actor === winner.actor && candidate.key > winner.key)
    )
      winner = candidate;
  }
  const status: FactStatus = winner?.status ?? "proposed";
  const endsAt = winner?.expiresAt ?? options.expiresAt;
  // An unreadable end time means no known end, never "already over".
  const endMs = instant(endsAt);
  if (isOpenStatus(status) && Number.isFinite(endMs) && endMs <= options.now.getTime())
    return { status: "expired", row: winner, expired: true };
  return { status, row: winner, expired: false };
}
