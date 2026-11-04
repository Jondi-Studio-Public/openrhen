// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSignedInMark, markSignedIn, SIGNED_IN_BEFORE_KEY, wasSignedInBefore } from "./signed-in-marker";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("signed-in marker", () => {
  it("is set on sign-in, read back, and cleared on sign-out", () => {
    expect(wasSignedInBefore()).toBe(false);
    markSignedIn();
    expect(window.localStorage.getItem(SIGNED_IN_BEFORE_KEY)).toBe("1");
    expect(wasSignedInBefore()).toBe(true);
    clearSignedInMark();
    expect(wasSignedInBefore()).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => markSignedIn()).not.toThrow();
    expect(wasSignedInBefore()).toBe(false);
  });
});
