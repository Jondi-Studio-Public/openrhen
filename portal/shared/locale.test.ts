// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { dateTimeFormat, displayLocale, setDisplayLocale } from "./locale";

// The portal test setup (test/persona-defaults.ts) starts every file on en-AU; put it back after each test.
afterEach(() => setDisplayLocale("en-AU"));

describe("display locale", () => {
  it("is the default locale when none is stored", () => {
    setDisplayLocale(undefined);
    expect(displayLocale()).toBe("en");
  });

  it("follows a supported locale and returns to the default", () => {
    setDisplayLocale("en-US");
    expect(displayLocale()).toBe("en-US");
    setDisplayLocale(undefined);
    expect(displayLocale()).toBe("en");
  });

  it("refuses an unsupported locale", () => {
    setDisplayLocale("fr-FR");
    expect(displayLocale()).toBe("en");
  });
});

describe("dateTimeFormat", () => {
  it("returns the same instance for equal options", () => {
    const a = dateTimeFormat("en-AU", { timeZone: "UTC", month: "short" });
    expect(dateTimeFormat("en-AU", { timeZone: "UTC", month: "short" })).toBe(a);
    expect(dateTimeFormat("en-US", { timeZone: "UTC", month: "short" })).not.toBe(a);
  });

  it("still throws on an invalid time zone", () => {
    expect(() => dateTimeFormat("en-AU", { timeZone: "Not/AZone" })).toThrow();
  });
});
