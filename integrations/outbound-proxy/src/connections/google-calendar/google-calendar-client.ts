import { createHash } from "node:crypto";
import {
  googleCalendarEventSchema,
  googleCalendarListResponseSchema,
  type GoogleCalendarEvent,
  type GoogleCalendarFailureReason,
  type GoogleCalendarProofResult,
  type GoogleCalendarSummary
} from "@openrhen/contracts";

export interface GoogleCalendarConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/**
 * A Google Calendar failure with a machine-readable `reason` the portal maps straight onto its
 * connection health. The message is our own fixed wording: it never carries a response body, a token
 * or the client secret, because Google's error bodies can echo what was submitted.
 */
export class GoogleCalendarClientError extends Error {
  readonly reason: GoogleCalendarFailureReason;
  constructor(reason: GoogleCalendarFailureReason, message: string) {
    super(message);
    this.name = "GoogleCalendarClientError";
    this.reason = reason;
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://www.googleapis.com/calendar/v3";
/** The cached access token is treated as expired this long before Google says it is. */
const TOKEN_LEEWAY_MS = 60_000;
const MAX_PAGES = 50;

export function googleCalendarConfigFromEnv(env: Record<string, string | undefined> = process.env): {
  config?: GoogleCalendarConfig;
  missing: string[];
} {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const refreshToken = env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim();
  const missing = [
    ...(clientId ? [] : ["GOOGLE_CALENDAR_CLIENT_ID"]),
    ...(clientSecret ? [] : ["GOOGLE_CALENDAR_CLIENT_SECRET"]),
    ...(refreshToken ? [] : ["GOOGLE_CALENDAR_REFRESH_TOKEN"])
  ];
  if (missing.length || !clientId || !clientSecret || !refreshToken) return { missing };
  return { missing: [], config: { clientId, clientSecret, refreshToken } };
}

// --- access token -------------------------------------------------------------------------------

let tokenCache: { key: string; accessToken: string; expiresAt: number } | undefined;

/** Single-flight per credential: concurrent callers share one refresh instead of each hitting Google. */
const tokenInFlight = new Map<string, Promise<string>>();

export function clearGoogleCalendarTokenCacheForTests() {
  tokenCache = undefined;
  tokenInFlight.clear();
}

function cacheKey(config: GoogleCalendarConfig) {
  return createHash("sha256").update(`${config.clientId}\n${config.refreshToken}`).digest("hex");
}

async function safeFetch(fetcher: typeof fetch, url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetcher(url, init);
  } catch (error) {
    // An abort (timeout or client gone) is the caller's to handle, not a Google failure.
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new GoogleCalendarClientError(
      "network_error",
      "Could not reach Google Calendar. No planning data was changed."
    );
  }
}

async function googleErrorInfo(response: Response): Promise<{ oauthError?: string; reasons: string[] }> {
  try {
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as {
      error?: string | { errors?: { reason?: unknown }[]; status?: unknown };
    } | null;
    const error = body?.error;
    if (typeof error === "string") return { oauthError: error.trim().toLowerCase(), reasons: [] };
    const reasons = (error?.errors ?? [])
      .map((entry) => (typeof entry.reason === "string" ? entry.reason : ""))
      .filter(Boolean);
    if (typeof error?.status === "string") reasons.push(error.status);
    return { reasons };
  } catch {
    return { reasons: [] };
  }
}

async function accessToken(config: GoogleCalendarConfig, fetcher: typeof fetch, now: () => number) {
  const key = cacheKey(config);
  if (tokenCache && tokenCache.key === key && tokenCache.expiresAt - TOKEN_LEEWAY_MS > now())
    return tokenCache.accessToken;
  const running = tokenInFlight.get(key);
  if (running) {
    try {
      return await running;
    } catch (error) {
      // The refresh ran on the first caller's fetcher, so that caller's abort (client gone, timeout)
      // rejects it for everyone. Another caller's abort is not this caller's failure: refresh again
      // on this caller's own fetcher. If this caller was the one aborted, that fetch aborts too.
      if (!(error instanceof Error && error.name === "AbortError")) throw error;
      return refreshShared(config, fetcher, now, key);
    }
  }
  return refreshShared(config, fetcher, now, key);
}

function refreshShared(config: GoogleCalendarConfig, fetcher: typeof fetch, now: () => number, key: string) {
  const existing = tokenInFlight.get(key);
  if (existing) return existing;
  const attempt = refreshAccessToken(config, fetcher, now, key).finally(() => {
    if (tokenInFlight.get(key) === attempt) tokenInFlight.delete(key);
  });
  tokenInFlight.set(key, attempt);
  return attempt;
}

async function refreshAccessToken(config: GoogleCalendarConfig, fetcher: typeof fetch, now: () => number, key: string) {
  const response = await safeFetch(fetcher, TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken
    }).toString()
  });
  if (!response.ok) {
    tokenCache = undefined;
    const { oauthError } = await googleErrorInfo(response);
    if (response.status === 400 && oauthError === "invalid_grant")
      throw new GoogleCalendarClientError(
        "invalid_grant",
        "Google rejected the saved calendar sign-in (invalid_grant). Run the calendar sign-in again and replace GOOGLE_CALENDAR_REFRESH_TOKEN."
      );
    throw new GoogleCalendarClientError(
      response.status === 429 ? "rate_limited" : "upstream_error",
      `Google refused the calendar token request (HTTP ${response.status}${oauthError && /^[a-z_]{3,40}$/.test(oauthError) ? `, ${oauthError}` : ""}).`
    );
  }
  const body = (await response.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (!body || typeof body.access_token !== "string" || !body.access_token)
    throw new GoogleCalendarClientError("invalid_response", "Google returned an unexpected calendar token response.");
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  tokenCache = { key, accessToken: body.access_token, expiresAt: now() + expiresIn * 1000 };
  return body.access_token;
}

async function apiGet(
  config: GoogleCalendarConfig,
  url: URL,
  fetcher: typeof fetch,
  now: () => number
): Promise<Record<string, unknown>> {
  const token = await accessToken(config, fetcher, now);
  const response = await safeFetch(fetcher, url.toString(), {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" }
  });
  if (!response.ok) {
    if (response.status === 401) tokenCache = undefined;
    const { reasons } = await googleErrorInfo(response);
    if (response.status === 404)
      throw new GoogleCalendarClientError("calendar_not_found", "Google Calendar could not find that calendar.");
    if (
      response.status === 429 ||
      (response.status === 403 && reasons.some((reason) => /ratelimit|quota/i.test(reason)))
    )
      throw new GoogleCalendarClientError(
        "rate_limited",
        "Google Calendar is rate-limiting requests. Wait a little, then try again."
      );
    throw new GoogleCalendarClientError(
      "upstream_error",
      `Google Calendar returned HTTP ${response.status}. No planning data was changed.`
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new GoogleCalendarClientError("invalid_response", "Google Calendar returned an unexpected response.");
  return body as Record<string, unknown>;
}

// --- time helpers -------------------------------------------------------------------------------

function offsetMinutes(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000);
}

/** `YYYY-MM-DD` as local midnight in `timeZone`, written with its offset, e.g. `2026-10-05T00:00:00+11:00`. */
export function localMidnightWithOffset(date: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error("not a date");
  const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let offset = offsetMinutes(utcMidnight, timeZone);
  const corrected = offsetMinutes(utcMidnight - offset * 60_000, timeZone);
  if (corrected !== offset) offset = corrected;
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${date}T00:00:00${sign}${hh}:${mm}`;
}

// --- normalisation ------------------------------------------------------------------------------

type Raw = Record<string, unknown>;

const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);
const obj = (value: unknown): Raw | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : undefined;

interface Moment {
  iso: string;
  allDay: boolean;
  timeZone: string | undefined;
}

function moment(value: unknown, calendarTimeZone: string): Moment | undefined {
  const raw = obj(value);
  if (!raw) return undefined;
  const timeZone = str(raw.timeZone);
  const dateTime = str(raw.dateTime);
  if (dateTime) return { iso: dateTime, allDay: false, timeZone };
  const date = str(raw.date);
  if (date) return { iso: localMidnightWithOffset(date, timeZone ?? calendarTimeZone), allDay: true, timeZone };
  return undefined;
}

function normaliseEvent(item: Raw, calendarId: string, calendarTimeZone: string): GoogleCalendarEvent | undefined {
  const id = str(item.id);
  if (!id) return undefined;
  const status = item.status === "cancelled" ? "cancelled" : item.status === "tentative" ? "tentative" : "confirmed";
  // A cancelled instance of a series can come back carrying only its original start.
  const start =
    moment(item.start, calendarTimeZone) ??
    (status === "cancelled" ? moment(item.originalStartTime, calendarTimeZone) : undefined);
  if (!start) return undefined;
  const end = moment(item.end, calendarTimeZone) ?? start;
  return googleCalendarEventSchema.parse({
    externalEventId: id,
    calendarId,
    title: str(item.summary)?.trim() || "(No title)",
    description: str(item.description) ?? null,
    startsAt: start.iso,
    endsAt: end.iso,
    allDay: start.allDay,
    timezone: start.timeZone ?? end.timeZone ?? calendarTimeZone,
    location: str(item.location) ?? null,
    status,
    seriesId: str(item.recurringEventId) ?? null,
    updatedAt: str(item.updated) ?? start.iso
  });
}

// --- public API ---------------------------------------------------------------------------------

export async function listGoogleCalendars(
  config: GoogleCalendarConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<GoogleCalendarSummary[]> {
  const calendars: GoogleCalendarSummary[] = [];
  let pageToken: string | undefined;
  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${API_BASE}/users/me/calendarList`);
      url.searchParams.set("maxResults", "250");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const body = await apiGet(config, url, fetcher, now);
      for (const entry of Array.isArray(body.items) ? body.items : []) {
        const item = obj(entry);
        const calendarId = str(item?.id);
        if (!item || !calendarId) continue;
        calendars.push({
          calendarId,
          summary: str(item.summaryOverride) ?? str(item.summary) ?? calendarId,
          primary: item.primary === true,
          accessRole: str(item.accessRole) ?? "reader",
          timezone: str(item.timeZone) ?? "UTC"
        });
      }
      pageToken = str(body.nextPageToken);
      if (!pageToken) break;
    }
    return googleCalendarListResponseSchema.parse({ calendars }).calendars;
  } catch (error) {
    throw asClientError(error);
  }
}

export async function readGoogleCalendarEvents(
  config: GoogleCalendarConfig,
  calendarIds: string[],
  timeMin: string,
  timeMax: string,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<GoogleCalendarEvent[]> {
  const events: GoogleCalendarEvent[] = [];
  try {
    for (const calendarId of calendarIds) {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(`${API_BASE}/calendars/${encodeURIComponent(calendarId)}/events`);
        url.searchParams.set("timeMin", timeMin);
        url.searchParams.set("timeMax", timeMax);
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("showDeleted", "true");
        url.searchParams.set("maxResults", "2500");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const body = await apiGet(config, url, fetcher, now);
        const calendarTimeZone = str(body.timeZone) ?? "UTC";
        for (const entry of Array.isArray(body.items) ? body.items : []) {
          const item = obj(entry);
          const event = item ? normaliseEvent(item, calendarId, calendarTimeZone) : undefined;
          if (event) events.push(event);
        }
        pageToken = str(body.nextPageToken);
        if (!pageToken) break;
      }
    }
    return events;
  } catch (error) {
    throw asClientError(error);
  }
}

/** Anything that is not already a classified failure is a response we could not read. Aborts pass through. */
function asClientError(error: unknown): unknown {
  if (error instanceof GoogleCalendarClientError) return error;
  if (error instanceof Error && error.name === "AbortError") return error;
  return new GoogleCalendarClientError("invalid_response", "Google Calendar returned data this app could not read.");
}

export async function runGoogleCalendarProof(
  env: Record<string, string | undefined> = process.env,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now
): Promise<GoogleCalendarProofResult> {
  const resolved = googleCalendarConfigFromEnv(env);
  if (!resolved.config) return { status: "not_configured", missing: resolved.missing };
  const checkedAt = new Date(now()).toISOString();
  try {
    const calendars = await listGoogleCalendars(resolved.config, fetcher, now);
    return { status: "connected", checkedAt, calendarCount: calendars.length };
  } catch (error) {
    if (error instanceof GoogleCalendarClientError)
      return { status: "failed", checkedAt, message: error.message, reason: error.reason };
    throw error;
  }
}
