import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { PublicPulseV1 } from "@openrhen/contracts";
import { publishPulse, pulsePublishConfigFromEnv, signPulsePayload } from "./pulse-publish.js";

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

describe("pulsePublishConfigFromEnv", () => {
  it("is undefined when either variable is missing", () => {
    expect(pulsePublishConfigFromEnv({})).toBeUndefined();
    expect(pulsePublishConfigFromEnv({ PULSE_PUBLISH_URL: "https://x.example.com" })).toBeUndefined();
    expect(pulsePublishConfigFromEnv({ PULSE_PUBLISH_SECRET: "s" })).toBeUndefined();
  });

  it("refuses a non-https URL", () => {
    expect(
      pulsePublishConfigFromEnv({ PULSE_PUBLISH_URL: "http://tracker.example.com", PULSE_PUBLISH_SECRET: "s" })
    ).toBeUndefined();
  });

  it("refuses an unparseable URL", () => {
    expect(pulsePublishConfigFromEnv({ PULSE_PUBLISH_URL: "not a url", PULSE_PUBLISH_SECRET: "s" })).toBeUndefined();
  });

  it("accepts an https URL and reports its host", () => {
    const config = pulsePublishConfigFromEnv({
      PULSE_PUBLISH_URL: "https://tracker.example.com/api/pulse",
      PULSE_PUBLISH_SECRET: "s"
    });
    expect(config).toEqual({ url: "https://tracker.example.com/api/pulse", secret: "s", host: "tracker.example.com" });
  });
});

describe("signPulsePayload", () => {
  it("matches a fixed vector", () => {
    const now = new Date(1_700_000_000_000);
    const t = Math.floor(now.getTime() / 1000);
    const body = '{"v":1}';
    const expected = createHmac("sha256", "my-secret").update(`${t}.${body}`).digest("hex");
    expect(signPulsePayload("my-secret", body, now)).toBe(`t=${t},v1=${expected}`);
  });

  it("varies with the secret and the body", () => {
    const now = new Date();
    const a = signPulsePayload("secret-a", "body", now);
    const b = signPulsePayload("secret-b", "body", now);
    expect(a).not.toBe(b);
  });
});

describe("publishPulse", () => {
  const config = { url: "https://tracker.example.com/api/pulse", secret: "s", host: "tracker.example.com" };

  it("signs the exact bytes sent and posts them", async () => {
    let capturedBody: string | undefined;
    let capturedHeaders: Record<string, string> | undefined;
    const fetcher = (async (_input: unknown, init?: RequestInit) => {
      capturedBody = String(init?.body);
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const result = await publishPulse(samplePulse, config, fetcher);
    expect(result).toEqual({ outcome: "delivered", httpStatus: 200 });
    expect(capturedBody).toBe(JSON.stringify(samplePulse));
    expect(capturedHeaders?.["pulse-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(capturedHeaders?.["priorities-signature"]).toBe(capturedHeaders?.["pulse-signature"]);
  });

  it("maps a 4xx to rejected and a 5xx to failed", async () => {
    const rejected = await publishPulse(
      samplePulse,
      config,
      (async () => new Response(null, { status: 422 })) as typeof fetch
    );
    expect(rejected.outcome).toBe("rejected");
    const failed = await publishPulse(
      samplePulse,
      config,
      (async () => new Response(null, { status: 500 })) as typeof fetch
    );
    expect(failed.outcome).toBe("failed");
  });

  it("maps a network failure to failed", async () => {
    const result = await publishPulse(samplePulse, config, (async () => {
      throw new Error("network down");
    }) as typeof fetch);
    expect(result.outcome).toBe("failed");
  });

  it("refuses (rejected) a pulse object with an extra field, without ever calling fetch", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const result = await publishPulse({ ...samplePulse, extra: true } as unknown as PublicPulseV1, config, fetcher);
    expect(result.outcome).toBe("rejected");
    expect(called).toBe(false);
  });
});
