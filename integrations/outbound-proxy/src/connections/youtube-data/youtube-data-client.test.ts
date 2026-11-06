import { describe, expect, it, vi } from "vitest";
import { fetchVideoDurations, parseIsoDuration } from "./youtube-data-client.js";

const KEY = "AIzaSy-TEST-KEY-VALUE-123";
const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"];

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("parseIsoDuration", () => {
  it.each([
    ["PT4M13S", 253],
    ["PT1H", 3600],
    ["PT1H2M3S", 3723],
    ["PT45S", 45],
    ["P1DT2H", 93600],
    ["P1D", 86400],
    ["P1W", 604800],
    ["PT0S", null],
    ["P0D", null],
    ["PT1.5S", 2],
    ["", null],
    ["nonsense", null],
    ["PT-5S", null]
  ])("reads %s as %s seconds (zero, live and unreadable are null)", (text, seconds) => {
    expect(parseIsoDuration(text)).toBe(seconds);
  });
});

describe("fetchVideoDurations", () => {
  it("asks videos.list for contentDetails with the key in a header and never in the URL", async () => {
    const fetcher = reply(200, { items: [] });
    await fetchVideoDurations({ apiKey: KEY, ids }, fetcher);
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://www.googleapis.com/youtube/v3/videos");
    expect(parsed.searchParams.get("part")).toBe("contentDetails");
    expect(parsed.searchParams.get("id")).toBe(ids.join(","));
    // maxResults is not allowed together with id=, and Google answers 400 for it.
    expect(parsed.searchParams.has("maxResults")).toBe(false);
    expect([...parsed.searchParams.keys()].sort()).toEqual(["id", "part"]);
    expect(url).not.toContain(KEY);
    expect(url).not.toMatch(/key=/i);
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(KEY);
    expect(init.method ?? "GET").toBe("GET");
  });

  it("returns a length for each video found, null and unavailable for one that is missing", async () => {
    const result = await fetchVideoDurations(
      { apiKey: KEY, ids },
      reply(200, {
        items: [
          { id: "aaaaaaaaaaa", contentDetails: { duration: "PT4M13S" } },
          { id: "bbbbbbbbbbb", contentDetails: { duration: "P0D" } }
        ]
      })
    );
    expect(result).toEqual({
      ok: true,
      videos: [
        { id: "aaaaaaaaaaa", durationS: 253, unavailable: false },
        { id: "bbbbbbbbbbb", durationS: null, unavailable: false },
        { id: "ccccccccccc", durationS: null, unavailable: true }
      ]
    });
  });

  it("separates a quota failure from a bad key and from a key without access", async () => {
    const quota = await fetchVideoDurations(
      { apiKey: KEY, ids },
      reply(403, { error: { code: 403, message: "quota", errors: [{ reason: "quotaExceeded" }] } })
    );
    expect(quota).toMatchObject({ ok: false, status: 429, reason: "quota_exceeded" });
    const badKey = await fetchVideoDurations(
      { apiKey: KEY, ids },
      reply(400, {
        error: {
          code: 400,
          message: "API key not valid.",
          errors: [{ reason: "badRequest" }],
          status: "INVALID_ARGUMENT",
          details: [{ reason: "API_KEY_INVALID" }]
        }
      })
    );
    expect(badKey).toMatchObject({ ok: false, status: 401, reason: "invalid_credentials" });
    const noAccess = await fetchVideoDurations(
      { apiKey: KEY, ids },
      reply(403, { error: { code: 403, message: "not enabled", errors: [{ reason: "accessNotConfigured" }] } })
    );
    expect(noAccess).toMatchObject({ ok: false, status: 403, reason: "forbidden" });
  });

  it("treats a burst limit as a short pause, not a used-up day, and only the daily limits as quota", async () => {
    for (const reason of ["rateLimitExceeded", "userRateLimitExceeded"])
      expect(
        await fetchVideoDurations({ apiKey: KEY, ids }, reply(403, { error: { errors: [{ reason }] } }))
      ).toMatchObject({ ok: false, status: 429, reason: "rate_limited" });
    for (const reason of ["quotaExceeded", "dailyLimitExceeded"])
      expect(
        await fetchVideoDurations({ apiKey: KEY, ids }, reply(403, { error: { errors: [{ reason }] } }))
      ).toMatchObject({ ok: false, status: 429, reason: "quota_exceeded" });
  });

  it("answers an unexpected status or body as a failure without echoing Google's text", async () => {
    const result = await fetchVideoDurations({ apiKey: KEY, ids }, reply(500, { error: { message: `boom ${KEY}` } }));
    expect(result).toMatchObject({ ok: false, status: 502, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    const notJson = await fetchVideoDurations(
      { apiKey: KEY, ids },
      (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch
    );
    expect(notJson).toMatchObject({ ok: false, status: 502 });
  });

  it("scrubs a thrown fetch error, so a message holding the key never leaves", async () => {
    const throwing = (async () => {
      throw new Error(`request to https://x failed: header x-goog-api-key: ${KEY}`);
    }) as unknown as typeof fetch;
    const result = await fetchVideoDurations({ apiKey: KEY, ids }, throwing);
    expect(result).toMatchObject({ ok: false, status: 502, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
