import { googleCalendarFailureReasonSchema } from "@openrhen/contracts";
import { CalendarSourceError, readCalendarEvents } from "@/integrations/calendar-source-client";
import { ConnectionHostNotConfiguredError } from "@/integrations/connection-host-client";
import {
  CALENDAR_FEED_PROVIDER,
  FeedReadError,
  prepareFeedRead
} from "@/server/persistence/postgres/imports/calendar-profiles/calendar-feed";
import { localDateIn } from "@/server/persistence/postgres/imports/source-match-records";
import type { CalendarRead, CalendarSyncAdapter } from "./calendar-sync";

const FEED_URL_ENV = "CALENDAR_FEED_URL";
const PROXY_ENV = ["OUTBOUND_PROXY_URL", "OUTBOUND_PROXY_TOKEN"];

/**
 * Reads the one calendar feed over the window and hands the non-recurring events to the import store's diff (design
 * v4, build plan PR 6). Core, not private: it is registered in `calendar-sync.ts` against the `fixed_blocks` profile,
 * which only the feed uses (a second `fixed_blocks` connection would need the adapter looked up by provider as well).
 *
 * The proxy is the only thing that sees the URL, so nothing here can name it; every failure is worded from fixed text
 * and the proxy's own message (which names the host at most). The read is one download: no separate proof call.
 */
export const calendarFeedAdapter: CalendarSyncAdapter = {
  provider: CALENDAR_FEED_PROVIDER,
  sourceType: CALENDAR_FEED_PROVIDER,
  ownSourceType: "calendar_feed_event",
  async read({ timeMin, timeMax, timezone, env }): Promise<CalendarRead> {
    let response;
    try {
      response = await readCalendarEvents(
        CALENDAR_FEED_PROVIDER,
        {
          timeMin,
          timeMax,
          // The local days of the window in the owner's zone (the instants alone would slice to UTC days).
          dateStart: localDateIn(new Date(timeMin), timezone),
          dateEnd: localDateIn(new Date(timeMax), timezone),
          timezone
        },
        { env }
      );
    } catch (error) {
      if (error instanceof ConnectionHostNotConfiguredError) return { status: "not_configured", missing: PROXY_ENV };
      if (error instanceof CalendarSourceError) {
        if (error.reason === "not_configured") return { status: "not_configured", missing: [FEED_URL_ENV] };
        const reason = googleCalendarFailureReasonSchema.safeParse(error.reason);
        return { status: "failed", message: error.message, ...(reason.success ? { reason: reason.data } : {}) };
      }
      // Anything else (a response this build cannot parse) is worded here, never from the error's own text.
      return { status: "failed", message: "The calendar feed answer could not be read.", reason: "invalid_response" };
    }
    let prepared;
    try {
      prepared = prepareFeedRead(response);
    } catch (error) {
      if (error instanceof FeedReadError)
        return { status: "failed", message: error.message, reason: "invalid_response" };
      throw error;
    }
    return {
      status: "read",
      eventCount: prepared.rawEventCount,
      diff: (store) => store.diffCalendarFeed({ timezone, timeMin, timeMax, prepared })
    };
  }
};
