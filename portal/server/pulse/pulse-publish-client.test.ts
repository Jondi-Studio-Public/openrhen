import type { PublicPulseV1 } from "@openrhen/contracts";
import { describe, expect, it, vi } from "vitest";
import { fetchPulsePublishConfig, publishPulseViaProxy } from "./pulse-publish-client";

const samplePulse: PublicPulseV1 = {
  v: 1,
  seq: 1,
  generatedAt: "2026-09-26T14:00:00.000Z",
  state: "on",
  since: "2026-09-26T13:00:00.000Z",
  doing: { kind: "action", title: "Sort the bedroom floor" },
  private: false,
  shares: {
    today: { onPercent: 60, countedMinutes: 300 },
    days7: { onPercent: 55, countedMinutes: 2000 },
    days30: { onPercent: 50, countedMinutes: 8000 }
  }
};

const env = { OUTBOUND_PROXY_URL: "http://proxy.internal:4200/", OUTBOUND_PROXY_TOKEN: "test-token" };

const answer = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("pulse publish client", () => {
  it("reads the tracker config through the status_publish capability", async () => {
    const fetcher = answer(200, { configured: true, host: "tracker.example.com" });
    expect(await fetchPulsePublishConfig(env, fetcher)).toEqual({ configured: true, host: "tracker.example.com" });
    const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://proxy.internal:4200/capabilities/status_publish/pulse/config");
    expect(init.method).toBe("POST");
  });

  it("reports an unset sidecar as unconfigured without a request", async () => {
    const fetcher = answer(200, {});
    expect(await fetchPulsePublishConfig({}, fetcher)).toEqual({ configured: false, host: null });
    expect(await publishPulseViaProxy(samplePulse, {}, fetcher)).toEqual({
      outcome: "failed",
      error: "The pulse tracker is not configured."
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the proxy's message and status when the publish is refused", async () => {
    const result = await publishPulseViaProxy(
      samplePulse,
      env,
      answer(503, { error: "The pulse tracker is not configured." })
    );
    expect(result).toEqual({ outcome: "failed", httpStatus: 503, error: "The pulse tracker is not configured." });
  });

  it("returns the tracker outcome the proxy reports", async () => {
    const fetcher = answer(200, { outcome: "delivered", httpStatus: 204 });
    expect(await publishPulseViaProxy(samplePulse, env, fetcher)).toEqual({ outcome: "delivered", httpStatus: 204 });
    const [url] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe("http://proxy.internal:4200/capabilities/status_publish/pulse/publish");
  });
});
