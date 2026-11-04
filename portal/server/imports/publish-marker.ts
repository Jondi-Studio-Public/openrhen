// The round-trip marker OpenRhen writes into a published event's description, and the limit on automatic
// deletes. Neutral so the import profiles and the calendar sync can read them without naming the sink
// that publishes.

export const MARKER_PREFIX = "OpenRhen:";
export const DEFAULT_MAX_DELETES = 10;

/**
 * Whether a remote event's description carries any OpenRhen round-trip marker (`OpenRhen:<id>`): the
 * event is OpenRhen' own commitment echoed back by a calendar (a publish writes it, and a calendar
 * subscribed to that feed shows it), so no import proposes it as a new event.
 */
export function hasOpenRhenMarker(description: string | null | undefined): boolean {
  return (description ?? "")
    .split(/\s+/)
    .some((token) => token.startsWith(MARKER_PREFIX) && token.length > MARKER_PREFIX.length);
}
