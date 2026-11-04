import {
  calendarFeedExtrasSchema,
  calendarFeedProofResultSchema,
  type CalendarFeedFailureReason
} from "@openrhen/contracts/integrations/calendar-feed";
import {
  calendarEventSchema,
  calendarReadEventsRequestSchema,
  calendarReadEventsResponseSchema,
  connectionManifest,
  type CalendarEvent
} from "@openrhen/contracts";
import type { BoundConnection, OpResult } from "../../host/connection-api.js";
import { PLACEHOLDER_CREDENTIAL } from "../../host/http.js";
import { FeedFetchError, fetchCalendarFeed, type FeedFetchCode } from "./fetch.js";
import type { FeedEvent, ParseResult } from "./parse.js";
import { proveCalendarFeed } from "./proof.js";
import { FeedParseError, parseFeedInWorker } from "./run-worker.js";
import { isIanaZone } from "./zones.js";

/** The one secret. It holds a URL, so it is read here and nowhere else, and no message, log line or result carries it. */
const URL_ENV = "CALENDAR_FEED_URL";

/** The configured address, or null when the field is unset, blank or still the compose placeholder. */
function feedUrl(env: Record<string, string | undefined>): string | null {
  const value = env[URL_ENV]?.trim();
  return value && value !== PLACEHOLDER_CREDENTIAL ? value : null;
}

function notConfigured(): OpResult {
  return {
    status: 400,
    body: {
      error: "The calendar feed is not configured: CALENDAR_FEED_URL.",
      reason: "not_configured" satisfies CalendarFeedFailureReason,
      missing: [URL_ENV]
    }
  };
}

const FAILURES: Record<FeedFetchCode, { status: number; reason: CalendarFeedFailureReason; text: string }> = {
  bad_url: { status: 400, reason: "not_configured", text: "The calendar feed address is not a usable https address" },
  denied_address: {
    status: 502,
    reason: "forbidden",
    text: "The calendar feed host resolves to an address that is not allowed"
  },
  dns_failed: { status: 502, reason: "unreachable", text: "The calendar feed host could not be resolved" },
  connect_failed: { status: 502, reason: "unreachable", text: "The calendar feed host could not be reached" },
  timeout: { status: 502, reason: "unreachable", text: "The calendar feed timed out" },
  aborted: { status: 502, reason: "unreachable", text: "The calendar feed request was cancelled" },
  network: { status: 502, reason: "unreachable", text: "The calendar feed connection failed" },
  bad_redirect: {
    status: 502,
    reason: "invalid_response",
    text: "The calendar feed redirected somewhere that is not allowed"
  },
  too_many_redirects: { status: 502, reason: "invalid_response", text: "The calendar feed redirected too many times" },
  http_status: { status: 502, reason: "upstream_error", text: "The calendar feed host refused the request" },
  too_large: { status: 502, reason: "invalid_response", text: "The calendar feed is larger than the limit" },
  decode_failed: { status: 502, reason: "invalid_response", text: "The calendar feed could not be decoded" },
  unsupported_encoding: {
    status: 502,
    reason: "invalid_response",
    text: "The calendar feed uses an unsupported encoding"
  }
};

/** A fetch or proof failure as a result. The text is fixed per code plus the host and, for a refusal, its HTTP status; the URL never appears. */
function fetchFailure(error: FeedFetchError): OpResult & { reason: CalendarFeedFailureReason; message: string } {
  const failure = FAILURES[error.code];
  const message = `${failure.text}${error.host ? ` (${error.host}${error.status ? `, status ${error.status}` : ""})` : ""}.`;
  return { status: failure.status, reason: failure.reason, message, body: { error: message, reason: failure.reason } };
}

const UNEXPECTED = "The calendar feed check failed.";

/** A feed occurrence as the generic `CalendarEvent`. What the parser knows beyond that rides in `attributes`. */
export function toCalendarEvent(event: FeedEvent, ownerTimeZone: string): CalendarEvent {
  return {
    externalEventId: event.id,
    calendarId: null,
    title: event.title,
    description: event.description || null,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    allDay: event.allDay,
    // An all-day event's midnights are in the owner's zone; a timed one carries absolute instants.
    timezone: event.allDay ? ownerTimeZone : null,
    location: event.location || null,
    status: event.status,
    seriesId: event.recurring ? event.uid : null,
    recurring: event.recurring,
    updatedAt: null,
    profileLabel: null,
    attributes: {
      uid: event.uid,
      recurrenceDate: event.recurrenceDate,
      startDate: event.startDate,
      endDate: event.endDate,
      ...(event.series ? { series: event.series } : {})
    }
  };
}

/** The proxy's half of `complete` (design v4 (g)): the final hop answered 200 (a fetch returns only then) and the parser finished with BEGIN and END seen and no cap or budget hit. */
function transportComplete(parsed: ParseResult): boolean {
  return (
    parsed.parseComplete &&
    parsed.sawBegin &&
    parsed.sawEnd &&
    !parsed.veventCapHit &&
    !parsed.occurrenceCapHit &&
    !parsed.timeBudgetHit
  );
}

function manifest() {
  const found = connectionManifest("calendar_feed");
  if (!found) throw new Error("The calendar_feed manifest is missing from the registry.");
  return found;
}

export const calendarFeedConnection: BoundConnection = {
  manifest: manifest(),
  create: () => ({
    calendar_source: {
      proof: {
        kind: "json",
        async run(call) {
          const url = feedUrl(call.env);
          if (!url)
            return {
              status: 200,
              body: calendarFeedProofResultSchema.parse({ status: "not_configured", missing: [URL_ENV] })
            };
          const checkedAt = new Date().toISOString();
          try {
            const { host } = await proveCalendarFeed(url, { signal: call.signal });
            return { status: 200, body: calendarFeedProofResultSchema.parse({ status: "connected", checkedAt, host }) };
          } catch (error) {
            // A gone client aborted the call: the host answers that, not a feed failure.
            if (call.signal.aborted) throw error;
            const failure =
              error instanceof FeedFetchError
                ? fetchFailure(error)
                : { reason: "unreachable" as const, message: UNEXPECTED };
            return {
              status: 502,
              body: calendarFeedProofResultSchema.parse({
                status: "failed",
                checkedAt,
                message: failure.message,
                reason: failure.reason
              })
            };
          }
        }
      },
      read_events: {
        kind: "json",
        async run(call) {
          const parsedRequest = calendarReadEventsRequestSchema.safeParse(call.body);
          if (!parsedRequest.success)
            return { status: 400, body: { error: "The calendar feed events request failed validation." } };
          const { timeMin, timeMax, timezone } = parsedRequest.data;
          if (timezone !== undefined && !isIanaZone(timezone))
            return { status: 400, body: { error: "The calendar feed events request named an unknown timezone." } };
          const url = feedUrl(call.env);
          if (!url) return notConfigured();
          // Floating and all-day times need a zone; the owner's when the portal sends it, UTC otherwise.
          const ownerTimeZone = timezone ?? "UTC";
          try {
            const fetched = await fetchCalendarFeed(url, { signal: call.signal });
            const parsed = await parseFeedInWorker(
              {
                body: fetched.bytes,
                now: new Date().toISOString(),
                windowStart: timeMin,
                windowEnd: timeMax,
                ownerTimeZone
              },
              { signal: call.signal }
            );
            const events = parsed.events.map((event) =>
              calendarEventSchema.parse(toCalendarEvent(event, ownerTimeZone))
            );
            return {
              status: 200,
              body: calendarReadEventsResponseSchema.parse({
                events,
                scope: { frameId: null, timezone: ownerTimeZone },
                extras: calendarFeedExtrasSchema.parse({
                  host: fetched.host,
                  transportComplete: transportComplete(parsed),
                  veventCount: parsed.veventCount,
                  skipped: parsed.skipped,
                  unrepresentableSeries: parsed.unrepresentableSeries,
                  veventCapHit: parsed.veventCapHit,
                  occurrenceCapHit: parsed.occurrenceCapHit,
                  timeBudgetHit: parsed.timeBudgetHit
                })
              })
            };
          } catch (error) {
            // A timeout or a gone client aborted the call: the host answers that (504 or nothing), not a feed failure.
            if (call.signal.aborted) throw error;
            if (error instanceof FeedFetchError) return fetchFailure(error);
            // Parse failures and anything unexpected carry no feed content: a fixed message only.
            const reason: CalendarFeedFailureReason = "invalid_response";
            const bad = error instanceof FeedParseError && error.code === "bad_request";
            return {
              status: bad ? 400 : 502,
              body: {
                error: bad
                  ? "The calendar feed events request failed validation."
                  : "The calendar feed could not be read.",
                reason
              }
            };
          }
        }
      }
    }
  })
};
