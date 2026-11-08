import { describe, expect, it } from "vitest";
import { BACKFILL_LIMITS, estimateBackfill } from "./backfill-estimate.js";

describe("estimateBackfill", () => {
  it("multiplies messages by tokens and seconds per message", () => {
    expect(estimateBackfill({ messages: 100_000, tokensPerMessage: 800, secondsPerMessage: 2 })).toEqual({
      messages: 100_000,
      modelMessages: 100_000,
      totalTokens: 80_000_000,
      totalSeconds: 200_000,
      totalHours: 200_000 / 3600,
      usd: null
    });
  });

  it("leaves out the messages headers alone resolve, rounding the rest up", () => {
    const estimate = estimateBackfill({ messages: 1001, tokensPerMessage: 500, secondsPerMessage: 1.5, t0Share: 0.6 });
    expect(estimate.modelMessages).toBe(401); // ceil(1001 * 0.4) = 401
    expect(estimate.totalTokens).toBe(401 * 500);
    expect(estimate.totalSeconds).toBeCloseTo(601.5, 10);
  });

  it("divides wall-clock time by parallelism but not tokens, and prices tokens when a rate is given", () => {
    const estimate = estimateBackfill({
      messages: 1000,
      tokensPerMessage: 1000,
      secondsPerMessage: 4,
      parallelism: 4,
      usdPerMillionTokens: 3
    });
    expect(estimate.totalTokens).toBe(1_000_000);
    expect(estimate.totalSeconds).toBe(1000);
    expect(estimate.usd).toBeCloseTo(3, 10);
  });

  it("is zero for no messages", () => {
    expect(estimateBackfill({ messages: 0, tokensPerMessage: 1, secondsPerMessage: 1 })).toMatchObject({
      modelMessages: 0,
      totalTokens: 0,
      totalSeconds: 0
    });
  });

  it("refuses bad inputs, naming the field, the allowed range and the fix", () => {
    expect(() => estimateBackfill({ messages: -1, tokensPerMessage: 1, secondsPerMessage: 1 })).toThrow(
      /messages.*whole number.*0 or more/
    );
    expect(() => estimateBackfill({ messages: 1, tokensPerMessage: Number.NaN, secondsPerMessage: 1 })).toThrow(
      /tokensPerMessage/
    );
    expect(() => estimateBackfill({ messages: 1, tokensPerMessage: 1, secondsPerMessage: -2 })).toThrow(
      /secondsPerMessage/
    );
    expect(() => estimateBackfill({ messages: 1, tokensPerMessage: 1, secondsPerMessage: 1, t0Share: 1.2 })).toThrow(
      /t0Share.*0 to 1/
    );
    expect(() => estimateBackfill({ messages: 1, tokensPerMessage: 1, secondsPerMessage: 1, parallelism: 0 })).toThrow(
      /parallelism/
    );
  });

  it("bounds every input, naming the limit, so a typo cannot produce a absurd figure", () => {
    const ok = { messages: 1, tokensPerMessage: 1, secondsPerMessage: 1 };
    expect(() => estimateBackfill({ ...ok, messages: BACKFILL_LIMITS.messages + 1 })).toThrow(
      /messages.*at most 1000000000/
    );
    expect(() => estimateBackfill({ ...ok, tokensPerMessage: BACKFILL_LIMITS.tokensPerMessage + 1 })).toThrow(
      /tokensPerMessage.*at most 1000000/
    );
    expect(() => estimateBackfill({ ...ok, secondsPerMessage: BACKFILL_LIMITS.secondsPerMessage + 1 })).toThrow(
      /secondsPerMessage.*at most 3600/
    );
    expect(() => estimateBackfill({ ...ok, usdPerMillionTokens: BACKFILL_LIMITS.usdPerMillionTokens + 1 })).toThrow(
      /usdPerMillionTokens.*at most 1000/
    );
    expect(() => estimateBackfill({ ...ok, parallelism: BACKFILL_LIMITS.parallelism + 1 })).toThrow(
      /parallelism.*at most 1000/
    );
    expect(estimateBackfill({ ...ok, messages: BACKFILL_LIMITS.messages }).messages).toBe(1_000_000_000);
  });
});
