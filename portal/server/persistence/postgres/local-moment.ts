import { DEFAULT_TIMEZONE, resolveLocale } from "@openrhen/contracts";
import { formatZonedMoment } from "@/shared/date-format";
import type { Sql } from "./sql-pool";

/**
 * Formats moments for a rejection message in the person's own timezone (`users.timezone`), so the
 * message names "2:56 pm" rather than a UTC ISO string they would have to convert.
 */
export async function localMomentFormatter(tx: Sql, userId: string, now: Date): Promise<(moment: Date) => string> {
  const rows = await tx<
    { timezone: string | null; locale: string | null }[]
  >`SELECT timezone, locale FROM users WHERE id=${userId}`;
  return momentFormatter(rows[0], now);
}

/** The same, for the owner of session `sessionId`. */
export async function sessionMomentFormatter(tx: Sql, sessionId: string, now: Date): Promise<(moment: Date) => string> {
  const rows = await tx<
    { timezone: string | null; locale: string | null }[]
  >`SELECT u.timezone, u.locale FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=${sessionId}`;
  return momentFormatter(rows[0], now);
}

function momentFormatter(
  user: { timezone: string | null; locale: string | null } | undefined,
  now: Date
): (moment: Date) => string {
  const zone = user?.timezone ?? DEFAULT_TIMEZONE;
  const locale = resolveLocale(user?.locale);
  return (moment) => formatZonedMoment(moment, zone, now, locale);
}
