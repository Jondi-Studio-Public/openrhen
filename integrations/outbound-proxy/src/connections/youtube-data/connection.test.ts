import { capabilityFailureSchema } from "@openrhen/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpCall } from "../../host/connection-api.js";
import { youtubeDataConnection } from "./connection.js";

const FAKE_VALUE = "fakeyt-SECRET-FAKE_VALUE-000";
const op = youtubeDataConnection.create({}).video_metadata!.durations!;

function call(body: unknown, fetcher: typeof fetch, signal = new AbortController().signal): OpCall {
  return { body, fetch: fetcher, signal, env: {}, pathname: "/capabilities/video_metadata/youtube_data/durations" };
}

afterEach(() => vi.restoreAllMocks());

describe("youtube_data connection", () => {
  it("is always ready: it takes its credential from each request and names no environment secret", () => {
    expect(youtubeDataConnection.manifest.credentialSource).toBe("request");
    expect(youtubeDataConnection.manifest.secrets.anyOf).toEqual([]);
    expect(youtubeDataConnection.manifest.capabilities).toEqual(["video_metadata"]);
  });

  it("answers lengths for a valid body", async () => {
    const fetcher = (async () =>
      new Response(
        JSON.stringify({ items: [{ id: "aaaaaaaaaaa", contentDetails: { duration: "PT1M" } }] })
      )) as unknown as typeof fetch;
    expect(await op.run(call({ apiKey: FAKE_VALUE, ids: ["aaaaaaaaaaa"] }, fetcher))).toEqual({
      status: 200,
      body: { videos: [{ id: "aaaaaaaaaaa", durationS: 60, unavailable: false }] }
    });
  });

  it("refuses a body without a key, with a bad id, or with more than 50 ids, before calling Google", async () => {
    const fetcher = vi.fn() as unknown as typeof fetch;
    for (const body of [
      {},
      { apiKey: FAKE_VALUE, ids: [] },
      { apiKey: FAKE_VALUE, ids: ["short"] },
      { apiKey: FAKE_VALUE, ids: Array.from({ length: 51 }, () => "aaaaaaaaaaa") },
      { ids: ["aaaaaaaaaaa"] }
    ]) {
      const result = await op.run(call(body, fetcher));
      expect((result as { status: number }).status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("answers quota, bad key and network failure as well-formed failures", async () => {
    const quota = (async () =>
      new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), {
        status: 403
      })) as unknown as typeof fetch;
    const quotaResult = (await op.run(call({ apiKey: FAKE_VALUE, ids: ["aaaaaaaaaaa"] }, quota))) as {
      status: number;
      body: unknown;
    };
    expect(quotaResult.status).toBe(429);
    expect(capabilityFailureSchema.parse(quotaResult.body).reason).toBe("quota_exceeded");
    const down = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const downResult = (await op.run(call({ apiKey: FAKE_VALUE, ids: ["aaaaaaaaaaa"] }, down))) as {
      status: number;
      body: unknown;
    };
    expect(downResult.status).toBe(502);
    expect(capabilityFailureSchema.safeParse(downResult.body).success).toBe(true);
  });

  it("never lets a thrown error that quotes the key reach the response, the console or stderr", async () => {
    const writes: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => void writes.push(args.join(" ")));
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (writes.push(String(chunk)), true));
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (writes.push(String(chunk)), true));
    const leaky = (async () => {
      throw new Error(`fetch failed for header x-goog-api-key=${FAKE_VALUE}`);
    }) as unknown as typeof fetch;
    const result = await op.run(call({ apiKey: FAKE_VALUE, ids: ["aaaaaaaaaaa"] }, leaky));
    expect(JSON.stringify(result)).not.toContain(FAKE_VALUE);
    expect(writes.join("\n")).not.toContain(FAKE_VALUE);
  });

  it("rethrows a cancelled call with a message that holds no key", async () => {
    const controller = new AbortController();
    const leaky = (async () => {
      controller.abort();
      throw new Error(`aborted ${FAKE_VALUE}`);
    }) as unknown as typeof fetch;
    await expect(op.run(call({ apiKey: FAKE_VALUE, ids: ["aaaaaaaaaaa"] }, leaky, controller.signal))).rejects.toThrow(
      /cancelled/
    );
    await op.run(call({ apiKey: FAKE_VALUE, ids: ["aaaaaaaaaaa"] }, leaky, controller.signal)).catch((error: Error) => {
      expect(error.message).not.toContain(FAKE_VALUE);
    });
  });
});
