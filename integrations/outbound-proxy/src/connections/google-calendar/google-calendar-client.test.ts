import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGoogleCalendarTokenCacheForTests,
  GoogleCalendarClientError,
  listGoogleCalendars,
  localMidnightWithOffset,
  readGoogleCalendarEvents,
  runGoogleCalendarProof
} from "./google-calendar-client";

const config = {
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: "super-secret-client-value",
  refreshToken: "1//refresh-token-value"
};
const SECRETS = [config.clientSecret, config.refreshToken, "access-token-value"];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const tokenOk = (expiresIn = 3600) => json({ access_token: "access-token-value", expires_in: expiresIn });

/** Routes the token endpoint to `token`, everything else to `api`, and records every call. */
function fakeFetch(api: (url: URL) => Response, token: () => Response = () => tokenOk()) {
  const calls: URL[] = [];
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    calls.push(url);
    return url.hostname === "oauth2.googleapis.com" ? token() : api(url);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  return { fetcher, calls, tokenCalls: () => calls.filter((url) => url.hostname === "oauth2.googleapis.com").length };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as GoogleCalendarClientError;
  }
  throw new Error("expected a failure");
}

beforeEach(() => clearGoogleCalendarTokenCacheForTests());

describe("access token", () => {
  it("exchanges the refresh token once and reuses it until shortly before expiry", async () => {
    let clock = 1_000_000;
    const { fetcher, tokenCalls } = fakeFetch(() => json({ items: [] }));
    await listGoogleCalendars(config, fetcher, () => clock);
    await listGoogleCalendars(config, fetcher, () => clock + 30 * 60_000);
    expect(tokenCalls()).toBe(1);
    // Inside the 60s leeway of expiry: refreshed again.
    await listGoogleCalendars(config, fetcher, () => clock + 3600_000 - 30_000);
    expect(tokenCalls()).toBe(2);
  });

  it("does not fail a second request when the first caller's abort kills the shared refresh (F5-08)", async () => {
    const controller = new AbortController();
    const abortable = vi.fn(
      (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }))
          );
        })
    ) as unknown as typeof fetch;
    const { fetcher: healthy } = fakeFetch(() => json({ items: [] }));
    const first = listGoogleCalendars(config, abortable);
    const second = listGoogleCalendars(config, healthy);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBeDefined();
  });

  it("shares one token refresh between concurrent requests", async () => {
    const { fetcher, tokenCalls } = fakeFetch(() => json({ items: [] }));
    await Promise.all([listGoogleCalendars(config, fetcher), listGoogleCalendars(config, fetcher)]);
    expect(tokenCalls()).toBe(1);
  });

  it("lets the next request retry after a shared refresh fails", async () => {
    let fail = true;
    const { fetcher, tokenCalls } = fakeFetch(
      () => json({ items: [] }),
      () => (fail ? json({ error: "x" }, 500) : tokenOk())
    );
    const results = await Promise.allSettled([
      listGoogleCalendars(config, fetcher),
      listGoogleCalendars(config, fetcher)
    ]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(tokenCalls()).toBe(1);
    fail = false;
    await listGoogleCalendars(config, fetcher);
    expect(tokenCalls()).toBe(2);
  });

  it("sends the refresh grant and a bearer token", async () => {
    const seen: RequestInit[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(init ?? {});
      return new URL(String(input)).hostname === "oauth2.googleapis.com" ? tokenOk() : json({ items: [] });
    }) as typeof fetch;
    await listGoogleCalendars(config, fetcher);
    const body = new URLSearchParams(String(seen[0]!.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe(config.refreshToken);
    expect((seen[1]!.headers as Record<string, string>).authorization).toBe("Bearer access-token-value");
  });
});

describe("listGoogleCalendars", () => {
  it("follows nextPageToken and maps summaries", async () => {
    const { fetcher, calls } = fakeFetch((url) =>
      url.searchParams.get("pageToken") === "p2"
        ? json({
            items: [{ id: "holidays@group", summary: "Holidays", accessRole: "reader", timeZone: "Australia/Sydney" }]
          })
        : json({
            nextPageToken: "p2",
            items: [
              {
                id: "me@example.com",
                summary: "Me",
                summaryOverride: "Alex",
                primary: true,
                accessRole: "owner",
                timeZone: "Australia/Sydney"
              }
            ]
          })
    );
    const calendars = await listGoogleCalendars(config, fetcher);
    expect(calendars).toEqual([
      {
        calendarId: "me@example.com",
        summary: "Alex",
        primary: true,
        accessRole: "owner",
        timezone: "Australia/Sydney"
      },
      {
        calendarId: "holidays@group",
        summary: "Holidays",
        primary: false,
        accessRole: "reader",
        timezone: "Australia/Sydney"
      }
    ]);
    expect(calls.filter((url) => url.pathname.endsWith("/calendarList"))).toHaveLength(2);
  });
});

describe("readGoogleCalendarEvents", () => {
  const window = ["2026-10-01T00:00:00+10:00", "2026-11-01T00:00:00+11:00"] as const;

  it("asks for single events including deleted, and pages through results", async () => {
    const { fetcher, calls } = fakeFetch((url) =>
      url.searchParams.get("pageToken") === "next"
        ? json({
            timeZone: "Australia/Sydney",
            items: [
              {
                id: "b",
                summary: "Second",
                start: { dateTime: "2026-10-03T10:00:00+10:00" },
                end: { dateTime: "2026-10-03T11:00:00+10:00" },
                updated: "2026-09-01T00:00:00.000Z"
              }
            ]
          })
        : json({
            timeZone: "Australia/Sydney",
            nextPageToken: "next",
            items: [
              {
                id: "a",
                summary: "First",
                description: "notes",
                location: "Office",
                status: "tentative",
                start: { dateTime: "2026-10-02T09:00:00+10:00", timeZone: "Australia/Brisbane" },
                end: { dateTime: "2026-10-02T10:00:00+10:00" },
                updated: "2026-09-01T00:00:00.000Z"
              }
            ]
          })
    );
    const events = await readGoogleCalendarEvents(config, ["me@example.com"], window[0], window[1], fetcher);
    expect(events.map((event) => event.externalEventId)).toEqual(["a", "b"]);
    expect(events[0]).toMatchObject({
      calendarId: "me@example.com",
      title: "First",
      description: "notes",
      location: "Office",
      status: "tentative",
      allDay: false,
      timezone: "Australia/Brisbane",
      seriesId: null
    });
    const first = calls.find((url) => url.pathname.includes("/events"))!;
    expect(first.pathname).toBe("/calendar/v3/calendars/me%40example.com/events");
    expect(first.searchParams.get("singleEvents")).toBe("true");
    expect(first.searchParams.get("showDeleted")).toBe("true");
    expect(first.searchParams.get("maxResults")).toBe("2500");
    expect(first.searchParams.get("timeMin")).toBe(window[0]);
    expect(first.searchParams.get("timeMax")).toBe(window[1]);
  });

  it("turns all-day dates into local midnight with the zone's offset, and fills a missing title", async () => {
    const { fetcher } = fakeFetch(() =>
      json({
        timeZone: "Australia/Sydney",
        items: [
          // seed-zone is UTC+11 in October (daylight time) and UTC+10 in July.
          { id: "d1", start: { date: "2026-10-12" }, end: { date: "2026-10-13" }, updated: "2026-09-01T00:00:00Z" },
          {
            id: "d2",
            summary: "Winter",
            start: { date: "2026-07-01" },
            end: { date: "2026-07-02" },
            updated: "2026-06-01T00:00:00Z"
          }
        ]
      })
    );
    const [summer, winter] = await readGoogleCalendarEvents(config, ["c"], window[0], window[1], fetcher);
    expect(summer).toMatchObject({
      title: "(No title)",
      allDay: true,
      startsAt: "2026-10-12T00:00:00+11:00",
      endsAt: "2026-10-13T00:00:00+11:00",
      timezone: "Australia/Sydney"
    });
    expect(winter!.startsAt).toBe("2026-07-01T00:00:00+10:00");
    expect(localMidnightWithOffset("2026-10-04", "Australia/Sydney")).toBe("2026-10-04T00:00:00+10:00");
    expect(localMidnightWithOffset("2026-01-15", "America/New_York")).toBe("2026-01-15T00:00:00-05:00");
  });

  it("keeps a cancelled instance with its series id, even when only the original start is present", async () => {
    const { fetcher } = fakeFetch(() =>
      json({
        timeZone: "Australia/Sydney",
        items: [
          {
            id: "series_20261005T000000Z",
            status: "cancelled",
            recurringEventId: "series",
            originalStartTime: { dateTime: "2026-10-05T09:00:00+11:00" },
            updated: "2026-09-20T00:00:00.000Z"
          },
          {
            id: "series_20261012T000000Z",
            summary: "Standup",
            recurringEventId: "series",
            start: { dateTime: "2026-10-12T09:00:00+11:00" },
            end: { dateTime: "2026-10-12T09:15:00+11:00" },
            updated: "2026-09-20T00:00:00.000Z"
          }
        ]
      })
    );
    const events = await readGoogleCalendarEvents(config, ["c"], window[0], window[1], fetcher);
    expect(events.map((event) => [event.status, event.seriesId])).toEqual([
      ["cancelled", "series"],
      ["confirmed", "series"]
    ]);
    expect(events[0]!.startsAt).toBe("2026-10-05T09:00:00+11:00");
  });
});

describe("failures", () => {
  const run = (api: (url: URL) => Response, token?: () => Response) => {
    const { fetcher } = fakeFetch(api, token);
    return failure(readGoogleCalendarEvents(config, ["c"], "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", fetcher));
  };

  it("maps 400 invalid_grant from the token endpoint", async () => {
    const error = await run(
      () => json({}),
      () => json({ error: "invalid_grant", error_description: `Bad ${config.refreshToken}` }, 400)
    );
    expect(error).toBeInstanceOf(GoogleCalendarClientError);
    expect(error.reason).toBe("invalid_grant");
    expectNoSecrets(error.message);
  });

  it("maps 404 to calendar_not_found", async () => {
    expect((await run(() => json({ error: { code: 404 } }, 404))).reason).toBe("calendar_not_found");
  });

  it("maps 429 and 403 rateLimitExceeded to rate_limited", async () => {
    expect((await run(() => json({}, 429))).reason).toBe("rate_limited");
    expect((await run(() => json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403))).reason).toBe(
      "rate_limited"
    );
    expect((await run(() => json({ error: { errors: [{ reason: "forbidden" }] } }, 403))).reason).toBe(
      "upstream_error"
    );
  });

  it("maps 5xx to upstream_error", async () => {
    expect((await run(() => json({}, 503))).reason).toBe("upstream_error");
  });

  it("maps a thrown fetch to network_error without the cause text", async () => {
    const boom = (async () => {
      throw new Error(`connect failed for ${config.refreshToken}`);
    }) as typeof fetch;
    const error = await failure(listGoogleCalendars(config, boom));
    expect(error.reason).toBe("network_error");
    expectNoSecrets(error.message);
  });

  it("maps an unreadable response to invalid_response", async () => {
    expect((await run(() => new Response("<html>", { status: 200 }))).reason).toBe("invalid_response");
    expect(
      (await run(() => json({ items: [{ id: "x", start: { dateTime: "not a date" }, end: { dateTime: "nope" } }] })))
        .reason
    ).toBe("invalid_response");
  });

  it("never puts a token or the client secret in any failure message", async () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const error = await run(() => json({ error: `echo ${SECRETS.join(" ")}` }, status));
      expectNoSecrets(error.message);
    }
  });
});

describe("runGoogleCalendarProof", () => {
  const env = {
    GOOGLE_CALENDAR_CLIENT_ID: config.clientId,
    GOOGLE_CALENDAR_CLIENT_SECRET: config.clientSecret,
    GOOGLE_CALENDAR_REFRESH_TOKEN: config.refreshToken
  };

  it("names every missing variable", async () => {
    expect(await runGoogleCalendarProof({})).toEqual({
      status: "not_configured",
      missing: ["GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN"]
    });
  });

  it("reports the calendar count, or the failure reason", async () => {
    const ok = fakeFetch(() =>
      json({
        items: [
          { id: "a", summary: "A" },
          { id: "b", summary: "B" }
        ]
      })
    );
    expect(await runGoogleCalendarProof(env, ok.fetcher, () => Date.parse("2026-09-29T00:00:00Z"))).toEqual({
      status: "connected",
      checkedAt: "2026-09-29T00:00:00.000Z",
      calendarCount: 2
    });
    const bad = fakeFetch(
      () => json({}),
      () => json({ error: "invalid_grant" }, 400)
    );
    const result = await runGoogleCalendarProof(env, bad.fetcher);
    expect(result).toMatchObject({ status: "failed", reason: "invalid_grant" });
    expectNoSecrets(JSON.stringify(result));
  });
});

function expectNoSecrets(text: string) {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}
