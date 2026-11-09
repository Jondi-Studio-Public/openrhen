import { describe, expect, it } from "vitest";
import {
  defaultCalendarSyncProviderIds,
  intervalCalendarSourceIds,
  type CalendarSyncResult
} from "@openrhen/contracts";
import { EXAMPLE_DAILY_SOURCE, EXAMPLE_DEFAULT_SOURCE, EXAMPLE_INTERVAL_SOURCE } from "./calendar-sync-test-sources.js";
import {
  afterCalendarSyncAttempt,
  afterCalendarSyncNetworkError,
  applyObservedRun,
  calendarSyncDue,
  calendarSyncIntervalMs,
  calendarSyncIntervalMsFromEnv,
  calendarSyncPath,
  dailySyncSchedule,
  CALENDAR_SYNC_PROVIDERS,
  CALENDAR_SYNC_NETWORK_RETRY_MS,
  initialCalendarSyncState,
  isAuthFailure,
  isCalendarSyncAttempt,
  parseCalendarSyncProviders,
  seedCalendarSyncState
} from "./calendar-sync-schedule.js";

const timezone = "Australia/Sydney";
const hour = 3_600_000;
// 2026-06-15T19:00:00Z is 05:00 on 2026-06-16 in the seed zone (AEST, UTC+10).
const now = new Date("2026-06-15T19:00:00Z");

const synced: CalendarSyncResult = {
  status: "synced",
  provider: "google_calendar",
  syncedAt: "2026-06-15T19:00:00.000Z",
  timeMin: "2026-06-15T19:00:00.000Z",
  timeMax: "2026-09-13T19:00:00.000Z",
  eventCount: 3,
  updated: 0,
  deleted: 0,
  heldForReview: 0,
  reviewBatchId: null,
  committedBatchId: null
};
const failed = (reason?: "invalid_grant" | "upstream_error"): CalendarSyncResult => ({
  status: "failed",
  provider: "google_calendar",
  syncedAt: now.toISOString(),
  message: "boom",
  ...(reason ? { reason } : {})
});

describe("CALENDAR_SYNC_PROVIDERS", () => {
  it("is the interval-scheduled calendar sources, in this order", () => {
    expect([...CALENDAR_SYNC_PROVIDERS]).toEqual(intervalCalendarSourceIds());
    expect(CALENDAR_SYNC_PROVIDERS[0]).toBe("google_calendar");
    expect(CALENDAR_SYNC_PROVIDERS).toContain(EXAMPLE_INTERVAL_SOURCE);
    expect(CALENDAR_SYNC_PROVIDERS).not.toContain(EXAMPLE_DAILY_SOURCE);
  });
});

describe("parseCalendarSyncProviders", () => {
  it("defaults to the sources whose manifest sets syncByDefault, and to none when no manifest does", () => {
    const expected = defaultCalendarSyncProviderIds();
    expect(expected).toContain(EXAMPLE_DEFAULT_SOURCE);
    expect(expected).not.toContain(EXAMPLE_INTERVAL_SOURCE);
    expect(parseCalendarSyncProviders(undefined)).toEqual(expected);
    expect(parseCalendarSyncProviders("  ")).toEqual(expected);
  });
  it("reads a comma-separated list, ignoring unknown names and repeats", () => {
    expect(
      parseCalendarSyncProviders(`${EXAMPLE_INTERVAL_SOURCE}, google_calendar, ${EXAMPLE_INTERVAL_SOURCE}, nope`)
    ).toEqual(["google_calendar", EXAMPLE_INTERVAL_SOURCE]);
    expect(parseCalendarSyncProviders(EXAMPLE_INTERVAL_SOURCE)).toEqual([EXAMPLE_INTERVAL_SOURCE]);
  });
  it("can turn every provider off", () => {
    expect(parseCalendarSyncProviders("nope")).toEqual([]);
  });
});

describe("the calendar feed stays unscheduled until it is named", () => {
  it("is a known provider but joins no default or incidental list", () => {
    expect(CALENDAR_SYNC_PROVIDERS).toContain("calendar_feed");
    expect(parseCalendarSyncProviders(undefined)).not.toContain("calendar_feed");
    expect(parseCalendarSyncProviders("")).not.toContain("calendar_feed");
    expect(parseCalendarSyncProviders(`google_calendar,${EXAMPLE_INTERVAL_SOURCE}`)).not.toContain("calendar_feed");
    expect(parseCalendarSyncProviders("google_calendar, nope")).toEqual(["google_calendar"]);
  });
  it("is scheduled only by naming it, and a failed run never blocks it for the day", () => {
    expect(parseCalendarSyncProviders("calendar_feed")).toEqual(["calendar_feed"]);
    for (const reason of ["upstream_error", "invalid_grant"] as const)
      expect(
        isAuthFailure("calendar_feed", {
          status: "failed",
          provider: "calendar_feed",
          syncedAt: now.toISOString(),
          message: "boom",
          reason
        })
      ).toBe(false);
  });
});

describe("calendarSyncIntervalMs", () => {
  it("defaults to an hour and rejects nonsense", () => {
    expect(calendarSyncIntervalMs(undefined)).toBe(hour);
    expect(calendarSyncIntervalMs("0")).toBe(hour);
    expect(calendarSyncIntervalMs("1.5")).toBe(hour);
    expect(calendarSyncIntervalMs("abc")).toBe(hour);
  });
  it("reads minutes", () => {
    expect(calendarSyncIntervalMs("15")).toBe(15 * 60_000);
  });
  it("reads the variable the manifest names", () => {
    expect(calendarSyncIntervalMsFromEnv({ CALENDAR_SYNC_INTERVAL_MINUTES: "15" })).toBe(15 * 60_000);
    expect(calendarSyncIntervalMsFromEnv({})).toBe(hour);
  });
});

describe("calendarSyncPath", () => {
  it("names each provider's portal route", () => {
    expect(calendarSyncPath("google_calendar")).toBe("/api/connections/google_calendar/sync");
    expect(calendarSyncPath(EXAMPLE_INTERVAL_SOURCE)).toBe(`/api/connections/${EXAMPLE_INTERVAL_SOURCE}/sync`);
    expect(calendarSyncPath(EXAMPLE_DAILY_SOURCE)).toBe(`/api/connections/${EXAMPLE_DAILY_SOURCE}/sync`);
  });
});

describe("dailySyncSchedule", () => {
  it("reads a daily source's time from its manifest", () => {
    expect(dailySyncSchedule(EXAMPLE_DAILY_SOURCE)).toEqual({
      localTimeEnv: "EXAMPLE_DAILY_LOCAL_TIME",
      defaultLocalTime: "05:30"
    });
  });

  it("refuses a connection without a daily schedule", () => {
    expect(() => dailySyncSchedule(EXAMPLE_INTERVAL_SOURCE)).toThrow("no daily sync schedule");
    expect(() => dailySyncSchedule("nope")).toThrow("no daily sync schedule");
  });
});

describe("calendarSyncDue", () => {
  it("is due on the first tick, when it has never run", () => {
    expect(calendarSyncDue({ now, timezone, state: initialCalendarSyncState })).toEqual({
      due: true,
      localDate: "2026-06-16"
    });
  });

  it("is not due before the interval has passed, and is due once it has", () => {
    const state = afterCalendarSyncAttempt({
      provider: "google_calendar",
      result: synced,
      now,
      timezone,
      intervalMs: hour
    });
    expect(calendarSyncDue({ now: new Date(now.getTime() + hour - 1), timezone, state }).due).toBe(false);
    expect(calendarSyncDue({ now: new Date(now.getTime() + hour), timezone, state }).due).toBe(true);
  });

  it("retries a plain failure on the next interval, not at once", () => {
    const state = afterCalendarSyncAttempt({
      provider: "google_calendar",
      result: failed("upstream_error"),
      now,
      timezone,
      intervalMs: hour
    });
    expect(state.blockedLocalDate).toBeNull();
    expect(calendarSyncDue({ now: new Date(now.getTime() + 60_000), timezone, state }).due).toBe(false);
    expect(calendarSyncDue({ now: new Date(now.getTime() + hour), timezone, state }).due).toBe(true);
  });
});

describe("authentication back-off", () => {
  it("counts invalid_grant and not_configured as Google sign-in failures, and other failures as ordinary", () => {
    expect(isAuthFailure("google_calendar", failed("invalid_grant"))).toBe(true);
    expect(isAuthFailure("google_calendar", { status: "not_configured", missing: ["X"] })).toBe(true);
    expect(isAuthFailure("google_calendar", failed("upstream_error"))).toBe(false);
    expect(isAuthFailure("google_calendar", failed())).toBe(false);
    expect(isAuthFailure("google_calendar", synced)).toBe(false);
    expect(isAuthFailure("google_calendar", null)).toBe(false);
  });

  it("counts any failed run of a source whose manifest locks out on any failure", () => {
    expect(isAuthFailure(EXAMPLE_INTERVAL_SOURCE, failed("upstream_error"))).toBe(true);
    expect(isAuthFailure(EXAMPLE_INTERVAL_SOURCE, failed())).toBe(true);
    expect(isAuthFailure(EXAMPLE_INTERVAL_SOURCE, { ...synced, provider: EXAMPLE_INTERVAL_SOURCE })).toBe(false);
  });

  it("does not treat a provider the registry does not know as an authentication failure", () => {
    expect(isAuthFailure("some_new_source", failed("invalid_grant"))).toBe(false);
  });

  it("skips the provider for the rest of the local day, then tries again the next morning", () => {
    const state = afterCalendarSyncAttempt({
      provider: "google_calendar",
      result: failed("invalid_grant"),
      now,
      timezone,
      intervalMs: hour
    });
    expect(state.blockedLocalDate).toBe("2026-06-16");
    // Well past the interval, same local day (18:00 local): still blocked.
    expect(calendarSyncDue({ now: new Date("2026-06-16T08:00:00Z"), timezone, state }).due).toBe(false);
    // 23:59 local, still the 16th.
    expect(calendarSyncDue({ now: new Date("2026-06-16T13:59:00Z"), timezone, state }).due).toBe(false);
    // 00:00 on the 17th local.
    expect(calendarSyncDue({ now: new Date("2026-06-16T14:00:00Z"), timezone, state }).due).toBe(true);
  });

  it("is keyed by provider: one provider's block leaves the other's state alone", () => {
    const google = afterCalendarSyncAttempt({
      provider: "google_calendar",
      result: failed("invalid_grant"),
      now,
      timezone,
      intervalMs: hour
    });
    const other = afterCalendarSyncAttempt({
      provider: EXAMPLE_INTERVAL_SOURCE,
      result: { ...synced, provider: EXAMPLE_INTERVAL_SOURCE },
      now,
      timezone,
      intervalMs: hour
    });
    const later = new Date(now.getTime() + hour);
    expect(calendarSyncDue({ now: later, timezone, state: google }).due).toBe(false);
    expect(calendarSyncDue({ now: later, timezone, state: other }).due).toBe(true);
  });

  it("clears the block when a manual Sync now succeeds after it", () => {
    const blocked = afterCalendarSyncAttempt({
      provider: "google_calendar",
      result: failed("invalid_grant"),
      now,
      timezone,
      intervalMs: hour
    });
    const stillFailing = applyObservedRun(blocked, { startedAt: "2026-06-15T19:30:00.000Z", status: "failed" });
    expect(stillFailing).toEqual(blocked);
    const before = applyObservedRun(blocked, { startedAt: "2026-06-15T18:00:00.000Z", status: "synced" });
    expect(before).toEqual(blocked);
    const cleared = applyObservedRun(blocked, { startedAt: "2026-06-15T19:30:00.000Z", status: "needs_review" });
    expect(cleared.blockedLocalDate).toBeNull();
    expect(calendarSyncDue({ now: new Date(now.getTime() + hour), timezone, state: cleared }).due).toBe(true);
  });

  it("leaves an unblocked state alone when observing a run", () => {
    expect(applyObservedRun(initialCalendarSyncState, { startedAt: now.toISOString(), status: "synced" })).toBe(
      initialCalendarSyncState
    );
  });
});

describe("network errors", () => {
  it("retries sooner than a whole interval without blocking", () => {
    const state = afterCalendarSyncNetworkError(initialCalendarSyncState, now, hour);
    expect(state.blockedLocalDate).toBeNull();
    expect(state.nextAttemptAt).toBe(now.getTime() + CALENDAR_SYNC_NETWORK_RETRY_MS);
  });
  it("never waits longer than the interval itself", () => {
    expect(afterCalendarSyncNetworkError(initialCalendarSyncState, now, 60_000).nextAttemptAt).toBe(
      now.getTime() + 60_000
    );
  });
});

describe("seedCalendarSyncState", () => {
  it("is due at once when the portal has never recorded a run", () => {
    expect(seedCalendarSyncState({ provider: "google_calendar", lastRun: null, timezone, intervalMs: hour })).toEqual(
      initialCalendarSyncState
    );
  });

  it("does not run again straight after a restart that follows a recent run", () => {
    const state = seedCalendarSyncState({
      provider: "google_calendar",
      lastRun: { startedAt: now.toISOString(), status: "synced", summary: synced },
      timezone,
      intervalMs: hour
    });
    expect(calendarSyncDue({ now: new Date(now.getTime() + 10 * 60_000), timezone, state }).due).toBe(false);
    expect(calendarSyncDue({ now: new Date(now.getTime() + hour), timezone, state }).due).toBe(true);
  });

  it("stays blocked across a restart when the last run was a sign-in failure today", () => {
    const state = seedCalendarSyncState({
      provider: "google_calendar",
      lastRun: { startedAt: now.toISOString(), status: "failed", summary: failed("invalid_grant") },
      timezone,
      intervalMs: hour
    });
    expect(calendarSyncDue({ now: new Date(now.getTime() + 5 * hour), timezone, state }).due).toBe(false);
  });

  it("ignores an unreadable timestamp", () => {
    expect(
      seedCalendarSyncState({
        provider: "google_calendar",
        lastRun: { startedAt: "not a date", status: "synced" },
        timezone,
        intervalMs: hour
      })
    ).toEqual(initialCalendarSyncState);
  });
});

describe("isCalendarSyncAttempt", () => {
  it("is false for a missing or unstructured portal answer, so the caller retries soon", () => {
    expect(isCalendarSyncAttempt(null)).toBe(false);
    expect(isCalendarSyncAttempt({ error: "The request failed." })).toBe(false);
  });

  it("is true for a parsed sync result, failed included", () => {
    expect(isCalendarSyncAttempt({ status: "failed", message: "x", syncedAt: "2026-06-15T00:00:00Z" })).toBe(true);
    expect(isCalendarSyncAttempt({ status: "not_configured", missing: [] })).toBe(true);
  });
});

describe("already_running answers", () => {
  const alreadyRunning = {
    status: "already_running",
    provider: "google_calendar",
    message: "A sync is already running."
  };
  it("counts as an attempt, not a network error", () => {
    expect(isCalendarSyncAttempt(alreadyRunning)).toBe(true);
  });
  it("waits one interval and sets no block", () => {
    const state = afterCalendarSyncAttempt({
      provider: "google_calendar",
      result: alreadyRunning as CalendarSyncResult,
      now,
      timezone,
      intervalMs: hour
    });
    expect(state).toEqual({ nextAttemptAt: now.getTime() + hour, blockedLocalDate: null, blockedAt: null });
  });
});
