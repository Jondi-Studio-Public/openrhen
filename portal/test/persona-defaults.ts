/**
 * The portal tests were written for one person in a fixed non-UTC zone with DST, reading dates with a day-first locale. The
 * product's own defaults are now `UTC` and `en`, so this setup file gives the tests
 * that person once, here, instead of in every fixture:
 *
 * - `DEFAULT_TIMEZONE` reads `Australia/Sydney` for the portal modules that import it, which is what
 *   `createSeedState` and the planning defaults start from;
 * - the browser display locale is `en-AU`, as a stored `users.locale` of `en-AU` would set it.
 *
 * The default values themselves are tested where they live, in `platform/contracts/src/locale.test.ts`.
 * A test of "no stored value" behaviour should say so and read the constants with `vi.importActual`.
 */
import { vi } from "vitest";

vi.mock("@openrhen/contracts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openrhen/contracts")>()),
  DEFAULT_TIMEZONE: "Australia/Sydney"
}));

// `setDisplayLocale` does nothing outside a browser, so a Node test gets a window for this one call.
const { setDisplayLocale } = await import("@/shared/locale");
if (typeof window === "undefined") {
  vi.stubGlobal("window", {});
  setDisplayLocale("en-AU");
  vi.unstubAllGlobals();
} else {
  setDisplayLocale("en-AU");
}
