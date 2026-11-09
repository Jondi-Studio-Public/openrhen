import { DEFAULT_TIMEZONE, matchHandEntry, type SourceCommitment } from "@openrhen/contracts";
import { ensureUser } from "./ensure-user";
import { loadMatchContext } from "./imports/source-links";
import type { Sql } from "./sql-pool";

/**
 * The commitment a hand-typed one-off would duplicate,
 * as the editor's "Already on your plan" notice shows it. Read-only: nothing here writes, and a
 * `none` match is `null`.
 */
export interface HandEntryMatchWire {
  kind: "strong" | "possible";
  id: string;
  title: string;
  startsAt: string;
}

const DAY_MS = 86_400_000;

/** YYYY-MM-DD of an instant in `timezone`. */
export function localDateOf(instant: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(instant);
}

/** The best Strong or Possible match for the entry among `commitments`, or `null`. Pure. */
export function handEntryMatchFrom(
  input: { title: string; startsAt: string; endsAt: string },
  commitments: readonly SourceCommitment[],
  timezone: string
): HandEntryMatchWire | null {
  const match = matchHandEntry({ ...input, localDate: localDateOf(new Date(input.startsAt), timezone) }, commitments);
  if ((match.kind !== "strong" && match.kind !== "possible") || !match.commitmentId) return null;
  const found = commitments.find((item) => item.id === match.commitmentId);
  // A tie is a notice on the earliest of the tied commitments, never the "same one" claim of a strong match.
  return found
    ? { kind: match.tie ? "possible" : match.kind, id: found.id, title: found.title, startsAt: found.startsAt }
    : null;
}

/** Loads the plan's commitments for the day either side of the entry and matches against them. */
export async function findHandEntryMatch(
  sql: Sql,
  input: { title: string; startsAt: string; endsAt: string }
): Promise<HandEntryMatchWire | null> {
  const userId = await ensureUser(sql);
  const users = await sql<{ timezone: string }[]>`SELECT timezone FROM users WHERE id=${userId}`;
  const timezone = users[0]?.timezone ?? DEFAULT_TIMEZONE;
  const context = await loadMatchContext(sql, {
    userId,
    fromIso: new Date(Date.parse(input.startsAt) - DAY_MS).toISOString(),
    toIso: new Date(Date.parse(input.endsAt) + DAY_MS).toISOString(),
    timezone
  });
  return handEntryMatchFrom(input, context.commitments, timezone);
}
