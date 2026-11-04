import {
  googleCalendarFailureReasonSchema,
  googleCalendarProofResultSchema,
  type CalendarEvent,
  type GoogleCalendarFailureReason,
  type GoogleCalendarProofResult,
  type GoogleCalendarSummary,
  googleCalendarSummarySchema
} from "@openrhen/contracts";
import {
  CalendarSourceError,
  listSourceCalendars,
  proveCalendarSource,
  readCalendarEvents
} from "@/integrations/calendar-source-client";
import { ConnectionHostNotConfiguredError } from "@/integrations/connection-host-client";

/**
 * Google Calendar calls are made by the outbound-proxy sidecar, not from here: the refresh token is
 * set only on that container, which is never published on the LAN, and nothing is ever written back to
 * Google. These are thin wrappers over the generic
 * calendar-source client that keep the exports and error shapes the sync and the routes already use.
 */
const CONNECTION = "google_calendar";

const NOT_CONFIGURED = "Google Calendar is not configured: OUTBOUND_PROXY_URL, OUTBOUND_PROXY_TOKEN.";

/** An error that keeps the proxy's failure `reason`, so the sync can report it (and back off on it). */
export class GoogleCalendarProxyError extends Error {
  constructor(
    message: string,
    readonly reason?: GoogleCalendarFailureReason
  ) {
    super(message);
    this.name = "GoogleCalendarProxyError";
  }
}

function parseReason(value: unknown): GoogleCalendarFailureReason | undefined {
  const parsed = googleCalendarFailureReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Turns the generic client's errors into the Google-shaped one this module has always thrown. */
function asProxyError(error: unknown): unknown {
  if (error instanceof ConnectionHostNotConfiguredError)
    return new GoogleCalendarProxyError(NOT_CONFIGURED, "not_configured");
  if (error instanceof CalendarSourceError)
    return new GoogleCalendarProxyError(error.message, parseReason(error.reason));
  return error;
}

export async function fetchGoogleCalendarProof(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<GoogleCalendarProofResult> {
  const result = await proveCalendarSource(CONNECTION, { env, fetcher });
  const parsed = googleCalendarProofResultSchema.safeParse(result);
  if (parsed.success) return parsed.data;
  return {
    status: "failed",
    checkedAt: new Date().toISOString(),
    message: "Google Calendar returned a connectivity result this app could not read.",
    reason: "invalid_response"
  };
}

/** The account's calendars, as Google lists them. Throws on a non-2xx or an unconfigured sidecar. */
export async function fetchGoogleCalendars(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<GoogleCalendarSummary[]> {
  try {
    return googleCalendarSummarySchema.array().parse(await listSourceCalendars(CONNECTION, { env, fetcher }));
  } catch (error) {
    throw asProxyError(error);
  }
}

/**
 * Reads the events on the chosen calendars in `[timeMin, timeMax)`. Throws on a non-2xx or an
 * unconfigured sidecar, keeping `reason` off the response body when the sidecar attached one: the
 * caller (`calendar-sync.ts`) reports that reason rather than a bare "failed". The events come
 * back as the connection normalised them (`CalendarEvent`), straight into the diff.
 */
export async function fetchGoogleCalendarEvents(
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch
): Promise<CalendarEvent[]> {
  try {
    const { events } = await readCalendarEvents(
      CONNECTION,
      { calendarIds, timeMin, timeMax, dateStart: timeMin.slice(0, 10), dateEnd: timeMax.slice(0, 10) },
      { env, fetcher }
    );
    return events;
  } catch (error) {
    throw asProxyError(error);
  }
}
