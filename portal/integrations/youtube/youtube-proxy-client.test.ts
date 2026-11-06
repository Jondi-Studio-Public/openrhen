import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "@/server/persistence/postgres/sql-pool";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/server/secrets/read-secret", () => ({ readSecret: read }));

const { fetchVideoLengths } = await import("./youtube-proxy-client");

const FAKE_VALUE = "fakeyt-PORTAL-SIDE-FAKE_VALUE";
const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb"];
const env = { OUTBOUND_PROXY_URL: "http://proxy.test", OUTBOUND_PROXY_TOKEN: "t" };
const sql = {} as Sql;

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

beforeEach(() => read.mockReset());

describe("fetchVideoLengths", () => {
  it("sends the saved key in the request body to the video_metadata op, and nowhere else", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_VALUE });
    const fetcher = answer(200, { videos: [{ id: ids[0], durationS: 60, unavailable: false }] });
    const outcome = await fetchVideoLengths(sql, "u1", ids, { env, fetcher });
    expect(outcome).toEqual({ kind: "ok", videos: [{ id: ids[0], durationS: 60, unavailable: false }] });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://proxy.test/capabilities/video_metadata/youtube_data/durations");
    expect(url).not.toContain(FAKE_VALUE);
    expect(JSON.parse(String(init.body))).toEqual({ apiKey: FAKE_VALUE, ids });
    expect(JSON.stringify(init.headers)).not.toContain(FAKE_VALUE);
  });

  it("does not call the proxy without a readable key", async () => {
    const fetcher = answer(200, {});
    read.mockResolvedValue({ kind: "unset" });
    expect(await fetchVideoLengths(sql, "u1", ids, { env, fetcher })).toEqual({ kind: "no_key" });
    read.mockResolvedValue({ kind: "unreadable" });
    expect(await fetchVideoLengths(sql, "u1", ids, { env, fetcher })).toEqual({ kind: "key_unreadable" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps the proxy's failures to what the person needs to hear", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_VALUE });
    const cases: [number, unknown, string][] = [
      [429, { error: "x", reason: "quota_exceeded" }, "quota"],
      [429, { error: "x", reason: "rate_limited" }, "rate_limited"],
      [401, { error: "x", reason: "invalid_credentials" }, "bad_key"],
      [403, { error: "x", reason: "forbidden" }, "bad_key"],
      [502, { error: "x", reason: "unreachable" }, "unreachable"],
      [500, "garbage", "unreachable"]
    ];
    for (const [status, body, kind] of cases)
      expect(await fetchVideoLengths(sql, "u1", ids, { env, fetcher: answer(status, body) }), kind).toMatchObject({
        kind
      });
  });

  it("says the proxy is not set up, and treats a network error as unreachable, without the key in either", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_VALUE });
    expect(await fetchVideoLengths(sql, "u1", ids, { env: {}, fetcher: answer(200, {}) })).toEqual({
      kind: "not_ready"
    });
    const down = (async () => {
      throw new Error(`down ${FAKE_VALUE}`);
    }) as unknown as typeof fetch;
    const outcome = await fetchVideoLengths(sql, "u1", ids, { env, fetcher: down });
    expect(outcome).toEqual({ kind: "unreachable" });
  });

  it("reads the proxy refusing our own token (a bare 401) as not set up, not as Google being unreachable", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_VALUE });
    expect(await fetchVideoLengths(sql, "u1", ids, { env, fetcher: answer(401, { error: "Unauthorized" }) })).toEqual({
      kind: "not_ready"
    });
    // Google's own bad-key answer carries a reason and stays a bad key.
    expect(
      await fetchVideoLengths(sql, "u1", ids, {
        env,
        fetcher: answer(401, { error: "x", reason: "invalid_credentials" })
      })
    ).toEqual({ kind: "bad_key" });
  });

  it("treats an answer that is not the agreed shape as unreachable", async () => {
    read.mockResolvedValue({ kind: "ok", value: FAKE_VALUE });
    expect(await fetchVideoLengths(sql, "u1", ids, { env, fetcher: answer(200, { nope: 1 }) })).toEqual({
      kind: "unreachable"
    });
  });
});
