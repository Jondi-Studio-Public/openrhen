/**
 * The display locale for dates and times in the browser. This is the date-fns `setDefaultOptions`
 * and Luxon `Settings.defaultLocale` pattern: one module value that the provider sets once, and
 * that every formatter reads, so no helper needs a locale threaded through its callers.
 *
 * Only `portal/state/portal-provider.tsx` calls `setDisplayLocale`. Server code never calls
 * `setDisplayLocale` or `displayLocale`: it passes a locale explicitly (server modules may import
 * `dateTimeFormat`), and the setter does nothing outside a browser, so SSR and server code always
 * see the default and never another request's value.
 */
import { DEFAULT_LOCALE, resolveLocale } from "@openrhen/contracts";

let current: string = DEFAULT_LOCALE;

/** The locale to format dates in. */
export function displayLocale(): string {
  return current;
}

/** Sets the display locale from the stored one; an unsupported or missing tag gives the default. */
export function setDisplayLocale(stored: string | null | undefined): void {
  if (typeof window === "undefined") return;
  current = resolveLocale(stored);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** A cached `Intl.DateTimeFormat`; building one per call is slow on the hot render paths. */
export function dateTimeFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}\u0000${JSON.stringify(options)}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, formatter);
  }
  return formatter;
}
