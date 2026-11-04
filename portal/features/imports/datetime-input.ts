/**
 * The import review's datetime fields hold ISO text with an offset ("2026-08-20T17:00:00+10:00"). A
 * `datetime-local` input wants the wall-clock time with no zone, so these convert both ways in the
 * reading zone, keeping the offset in the stored text so the record still says which instant it means.
 */
function parts(date: Date, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value])
  );
  return values as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

/** Minutes the zone is ahead of UTC at that instant. */
function offsetMinutes(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
}

/** "2026-08-20T17:00" for a datetime-local input, or null when the text is not a datetime. */
export function isoToLocalInput(iso: string, timeZone: string): string | null {
  // Only text that names its instant: without an offset the browser would read it in its own zone,
  // which may not be the batch's, so it stays plain text for the reader to see and fix.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const p = parts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The ISO text, with the zone's offset at that wall time, for what a datetime-local input holds. */
export function localInputToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  // The offset at the wall time read as UTC is right except within an hour of a change; one more pass
  // settles it.
  let offset = offsetMinutes(new Date(wall), timeZone);
  offset = offsetMinutes(new Date(wall - offset * 60_000), timeZone);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${local}:00${sign}${hh}:${mm}`;
}
