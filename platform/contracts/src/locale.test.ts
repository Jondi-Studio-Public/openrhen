import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  isSupportedLocale,
  isValidTimeZone,
  resolveLocale,
  resolveTimezone,
  settingsLocale
} from "./locale.js";

describe("isValidTimeZone", () => {
  it("accepts real zones and aliases", () => {
    for (const zone of ["Australia/Sydney", "UTC", "Etc/GMT+10"]) expect(isValidTimeZone(zone)).toBe(true);
  });
  it("rejects typos and empty text", () => {
    expect(isValidTimeZone("Australia/Sydeny")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});

describe("isSupportedLocale", () => {
  it("accepts English variants", () => {
    for (const tag of ["en-AU", "en-US", "en-GB", "en"]) expect(isSupportedLocale(tag)).toBe(true);
  });
  it("rejects other languages and malformed tags", () => {
    for (const tag of ["fr-FR", "xx_bad", ""]) expect(isSupportedLocale(tag)).toBe(false);
  });
});

describe("resolveTimezone", () => {
  it("prefers stored, then env, then the default", () => {
    expect(resolveTimezone("Europe/London", { APP_TIMEZONE: "UTC" })).toBe("Europe/London");
    expect(resolveTimezone(null, { APP_TIMEZONE: "UTC" })).toBe("UTC");
    expect(resolveTimezone(undefined)).toBe(DEFAULT_TIMEZONE);
  });
  it("treats whitespace-only as missing", () => {
    expect(resolveTimezone("  ", { APP_TIMEZONE: " UTC " })).toBe("UTC");
    expect(resolveTimezone("  ", { APP_TIMEZONE: "  " })).toBe(DEFAULT_TIMEZONE);
  });
});

describe("resolveLocale", () => {
  it("prefers stored, then env, then the default", () => {
    expect(resolveLocale("en-GB", { APP_LOCALE: "en-US" })).toBe("en-GB");
    expect(resolveLocale(null, { APP_LOCALE: "en-US" })).toBe("en-US");
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
  it("falls through an invalid stored value and treats whitespace as missing", () => {
    expect(resolveLocale("xx_bad", { APP_LOCALE: "en-US" })).toBe("en-US");
    expect(resolveLocale("fr-FR", {})).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("  ", { APP_LOCALE: "  " })).toBe(DEFAULT_LOCALE);
  });
  it("returns canonical form", () => {
    expect(resolveLocale("en-us")).toBe("en-US");
  });
});

describe("settingsLocale", () => {
  it("is the default until settings carry a locale", () => {
    expect(settingsLocale({ timezone: "UTC" })).toBe(DEFAULT_LOCALE);
    expect(settingsLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});

describe("the defaults", () => {
  it("start a new install in UTC and plain English, with no region", () => {
    expect(DEFAULT_TIMEZONE).toBe("UTC");
    expect(DEFAULT_LOCALE).toBe("en");
    expect(resolveTimezone(undefined)).toBe("UTC");
    expect(resolveLocale(undefined)).toBe("en");
  });

  it("leave a stored en-AU alone", () => {
    expect(resolveLocale("en-AU")).toBe("en-AU");
    expect(settingsLocale({ locale: "en-AU" })).toBe("en-AU");
  });
});
