import { ensureUser } from "./ensure-user";
import type { PoolSql } from "./sql-pool";

/** The connection these selections belong to; the table is keyed by provider so another source can carry its own. */
const PROVIDER = "google_calendar";

/**
 * Which Google calendars the automatic sync reads (`calendar_source_selections`, provider `google_calendar`). Nothing is read until a
 * calendar is chosen: the account also carries shared, holiday and subscribed calendars that must never
 * import. A calendar the person has never ticked simply has no row.
 */
export interface GoogleCalendarSelection {
  calendarId: string;
  summary: string;
  selected: boolean;
}

export async function listGoogleCalendarSelections(sql: PoolSql): Promise<GoogleCalendarSelection[]> {
  const userId = await ensureUser(sql);
  const rows = await sql<{ calendar_id: string; summary: string; selected: boolean }[]>`
    SELECT calendar_id, summary, selected FROM calendar_source_selections
    WHERE user_id=${userId} AND provider=${PROVIDER} ORDER BY summary, calendar_id
  `;
  return rows.map((row) => ({ calendarId: row.calendar_id, summary: row.summary, selected: row.selected }));
}

/** Only the calendars currently ticked, which is what a sync reads. */
export async function listSelectedGoogleCalendars(sql: PoolSql): Promise<GoogleCalendarSelection[]> {
  return (await listGoogleCalendarSelections(sql)).filter((selection) => selection.selected);
}

/** Saves the given choices; a calendar not named keeps whatever it had. */
export async function saveGoogleCalendarSelections(
  sql: PoolSql,
  selections: GoogleCalendarSelection[]
): Promise<GoogleCalendarSelection[]> {
  const userId = await ensureUser(sql);
  await sql.begin(async (tx) => {
    for (const selection of selections)
      await tx`
        INSERT INTO calendar_source_selections (user_id, provider, calendar_id, summary, selected)
        VALUES (${userId}, ${PROVIDER}, ${selection.calendarId}, ${selection.summary}, ${selection.selected})
        ON CONFLICT (user_id, provider, calendar_id) DO UPDATE
          SET summary=EXCLUDED.summary, selected=EXCLUDED.selected,
              updated_at=CURRENT_TIMESTAMP, version=calendar_source_selections.version+1
      `;
  });
  return listGoogleCalendarSelections(sql);
}
