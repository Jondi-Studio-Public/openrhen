import { describe, expect, it } from "vitest";
import { createFailureThrottle, remoteAddress } from "./agent-token-throttle";

describe("createFailureThrottle", () => {
  it("allows the limit, then reports the seconds left in the window", () => {
    const throttle = createFailureThrottle(3, 60_000);
    for (let i = 0; i < 3; i += 1) {
      expect(throttle.retryAfter("a", 1000)).toBe(0);
      throttle.fail("a", 1000);
    }
    expect(throttle.retryAfter("a", 1000)).toBe(60);
    expect(throttle.retryAfter("a", 31_000)).toBe(30);
    expect(throttle.retryAfter("b", 1000)).toBe(0);
  });
  it("starts a fresh window after the old one ends", () => {
    const throttle = createFailureThrottle(1, 60_000);
    throttle.fail("a", 0);
    expect(throttle.retryAfter("a", 59_999)).toBe(1);
    expect(throttle.retryAfter("a", 60_000)).toBe(0);
  });
});

describe("remoteAddress", () => {
  it("takes the entry the nearest proxy appended, so a client cannot pick its own bucket", () => {
    expect(remoteAddress(new Headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe("2.2.2.2");
    expect(remoteAddress(new Headers())).toBe("direct");
  });
});
