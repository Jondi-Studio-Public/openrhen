import { describe, expect, it } from "vitest";
import { chatStreamIdleTimeoutMs, outboundRequestTimeoutMs } from "./runtime-env";

describe("outboundRequestTimeoutMs", () => {
  it("defaults to 30 seconds when unset", () => {
    expect(outboundRequestTimeoutMs({})).toBe(30_000);
  });

  it("honours a configured override", () => {
    expect(outboundRequestTimeoutMs({ OUTBOUND_REQUEST_TIMEOUT_MS: "5000" })).toBe(5_000);
  });

  it.each(["not-a-number", "0", "-5", "1.5"])("ignores an invalid value (%s) and falls back", (value) => {
    expect(outboundRequestTimeoutMs({ OUTBOUND_REQUEST_TIMEOUT_MS: value })).toBe(30_000);
  });
});

describe("chatStreamIdleTimeoutMs", () => {
  it("defaults to 60 seconds when unset", () => {
    expect(chatStreamIdleTimeoutMs({})).toBe(60_000);
  });

  it("honours a configured override", () => {
    expect(chatStreamIdleTimeoutMs({ CHAT_STREAM_IDLE_TIMEOUT_MS: "15000" })).toBe(15_000);
  });

  it("ignores an invalid value and falls back", () => {
    expect(chatStreamIdleTimeoutMs({ CHAT_STREAM_IDLE_TIMEOUT_MS: "nope" })).toBe(60_000);
  });
});
