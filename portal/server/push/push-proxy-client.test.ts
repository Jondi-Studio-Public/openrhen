import { describe, expect, it, vi } from "vitest";
import { sendPushViaProxy } from "./push-proxy-client";

const env = { OUTBOUND_PROXY_URL: "http://proxy.test", OUTBOUND_PROXY_TOKEN: "t" };
const request = {
  subscription: { endpoint: "https://push.example/x", keys: { p256dh: "p", auth: "a" } },
  payload: "{}",
  ttlSeconds: 60,
  urgency: "high",
  topic: "t"
} as never;

describe("sendPushViaProxy", () => {
  it("does not throw (and so is never re-sent) when the proxy accepted the send but its reply is unreadable", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ unexpected: true }), { status: 200 }));
    await expect(sendPushViaProxy(request, env, fetcher as never)).resolves.toEqual({ outcome: "delivered" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("still throws when the send itself could not be made", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(sendPushViaProxy(request, env, fetcher as never)).rejects.toThrow("ECONNREFUSED");
  });
});
