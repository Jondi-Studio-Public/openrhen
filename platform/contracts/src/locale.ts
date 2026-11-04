/**
 * The one home for the default timezone and display locale, and for the validators and resolvers
 * that read them. Nothing else in source spells these literals out.
 */

/** Default IANA timezone when nothing is stored and `APP_TIMEZONE` is unset. */
export const DEFAULT_TIMEZONE = "UTC";

/** Default display locale (BCP 47) when nothing is stored and `APP_LOCALE` is unset. */
export const DEFAULT_LOCALE = "en";

/**
 * The fixed locale for `formatToParts` that reads numbers, for day or year keys that are only
 * compared, and for fixed 24-hour text. Always pair it with `hourCycle: "h23"` when an hour is
 * read, never `hour12: false`.
 */
export const PARTS_LOCALE = "en-US";

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Whether the engine can construct a formatter for this zone. The check is the engine's own
 * construction, so it accepts aliases such as "UTC" and "Etc/GMT+10", which
 * `Intl.supportedValuesOf` omits.
 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat(PARTS_LOCALE, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Whether the tag is a well-formed English locale the runtime can format dates in. */
export function isSupportedLocale(tag: string): boolean {
  try {
    const [canonical] = Intl.getCanonicalLocales(tag);
    return (
      canonical !== undefined &&
      new Intl.Locale(canonical).language === "en" &&
      Intl.DateTimeFormat.supportedLocalesOf(canonical).length > 0
    );
  } catch {
    return false;
  }
}

/** English locales offered for the date format setting. */
export const DISPLAY_LOCALE_OPTIONS = ["en-AU", "en-GB", "en-US", "en-CA", "en-NZ", "en-IE", "en-IN", "en"] as const;

/** The stored timezone, then `APP_TIMEZONE`, then the default. Does not validate. */
export function resolveTimezone(stored: string | null | undefined, env: EnvLike = {}): string {
  return stored?.trim() || env.APP_TIMEZONE?.trim() || DEFAULT_TIMEZONE;
}

/**
 * The stored locale, then `APP_LOCALE`, then the default: the first that is supported, in canonical
 * form. It never returns a tag that `Intl` throws on.
 */
export function resolveLocale(stored: string | null | undefined, env: EnvLike = {}): string {
  for (const candidate of [stored?.trim(), env.APP_LOCALE?.trim()]) {
    if (candidate && isSupportedLocale(candidate)) return Intl.getCanonicalLocales(candidate)[0]!;
  }
  return DEFAULT_LOCALE;
}

/**
 * The display locale for a state's settings. Callers pass `state.settings` so that they need not know where the
 * stored field lives.
 */
export function settingsLocale(settings: unknown): string {
  return resolveLocale((settings as { locale?: string } | null | undefined)?.locale);
}
