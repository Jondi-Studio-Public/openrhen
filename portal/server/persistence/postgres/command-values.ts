/**
 * Validation and identity helpers shared by every command handler. Each throws
 * `InvalidCommandError` so a bad payload reads as a refusal the caller can show, not a crash.
 */
import { isSupportedLocale, isValidTimeZone, planCodePatternProblem } from "@openrhen/contracts";
import { InvalidCommandError, badValue, outOfRange, requiredValue } from "./command-errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function stableUuid(namespace: string, value: string): Promise<string> {
  if (UUID_PATTERN.test(value)) return value;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}:${value}`))
  );
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  // oxlint-disable-next-line unicorn/no-useless-spread -- spreads the Uint8Array into a plain array so map() yields strings, not coerced bytes
  const hex = [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw requiredValue(label);
  return value.trim();
}
/**
 * A calendar day written `YYYY-MM-DD` (a longer date-time string is read as its date part), checked
 * to be a real day. Postgres would otherwise refuse a malformed one deep inside the write as a 500.
 */
export function requiredLocalDate(value: unknown, label: string): string {
  const sent = requiredText(value, label);
  const text = sent.slice(0, 10);
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text)
    throw badValue(label, sent, "it must be a calendar day written YYYY-MM-DD", "2026-10-28");
  return text;
}

/**
 * A time zone the engine can actually use. The check is the engine's own construction
 * (`Intl.DateTimeFormat` with `timeZone`), so it accepts exactly what the engine will not throw on,
 * aliases such as "UTC" and "Etc/GMT+10" included, which `Intl.supportedValuesOf` omits. An invalid
 * zone saved here fails every plan run with no message the user can act on, and retrying cannot fix it.
 */
export function requiredTimeZone(value: unknown, label: string): string {
  const zone = requiredText(value, label);
  if (!isValidTimeZone(zone)) {
    throw badValue(label, zone, "it must be a valid IANA time zone", "Europe/London");
  }
  return zone;
}
/** An English locale the runtime can format dates in; it changes date and time formatting only. */
export function requiredLocale(value: unknown, label: string): string {
  const locale = requiredText(value, label);
  if (!isSupportedLocale(locale)) {
    throw badValue(label, locale, "it must be an English locale", "en-GB or en-US");
  }
  return locale;
}
/** The plan code pattern to store: null or empty clears it; anything else must pass the pattern check. */
export function planCodePatternValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string")
    throw badValue("The code pattern", value, "it must be text, or null or empty to clear it");
  const problem = planCodePatternProblem(value);
  if (problem) throw new InvalidCommandError(problem);
  return value.trim();
}
export function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
const isWhole = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);
export function nonNegativeInt(value: unknown, label: string): number {
  if (!isWhole(value)) throw badValue(label, value, "it must be a whole number, 0 or more", "0");
  if (value < 0) throw outOfRange(label, value, 0, Number.MAX_SAFE_INTEGER);
  return value;
}
export function positiveInt(value: unknown, label: string): number {
  if (!isWhole(value)) throw badValue(label, value, "it must be a whole number, 1 or more", "1");
  if (value < 1) throw outOfRange(label, value, 1, Number.MAX_SAFE_INTEGER);
  return value;
}
export function scoreInt(value: unknown, label: string): number {
  if (!isWhole(value)) throw badValue(label, value, "it must be a whole number from 1 to 5", "3");
  if (value < 1 || value > 5) throw outOfRange(label, value, 1, 5);
  return value;
}
export function fractionNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || value < 0 || value > 1)
    throw badValue(label, value, "it must be a number from 0 to 1", "0.8");
  return value;
}
/**
 * What a date refusal tells the agent to send. No literal offset: an example offset gets copied, and a copied
 * `+10:00` is a valid offset, so the write would be accepted hours away from the owner's own time.
 */
const DATE_EXAMPLE = "2026-11-04T09:00:00<offset>";
const DATE_OFFSET_RULE =
  "where <offset> is the owner's UTC offset on that date: take it from status.timezone (rhen_status), which also accounts for daylight saving";
export function requiredDate(value: unknown, label: string): Date {
  const result = optionalDate(value, label);
  if (!result) throw requiredValue(label, `${DATE_EXAMPLE}, ${DATE_OFFSET_RULE}`);
  return result;
}
/** A full ISO-8601 instant carrying an explicit offset (`Z` or `-05:00`); nothing else names one moment. */
const OFFSET_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * An offset-less string (`2026-10-02T09:00`, `2026-10-02`) would be read in the server's own zone (or as
 * UTC for a bare date), so the stored instant would move with the host — the client always sends an
 * offset, so anything else is rejected rather than guessed.
 */
export function optionalDate(value: unknown, label = "A supplied date"): Date | null {
  if (typeof value !== "string" || !value) return null;
  if (!OFFSET_INSTANT.test(value))
    throw badValue(
      label,
      value,
      "it must be a full ISO time with a UTC offset",
      `${DATE_EXAMPLE}, ${DATE_OFFSET_RULE}`
    );
  const result = new Date(value);
  if (Number.isNaN(result.getTime()))
    throw badValue(label, value, "it is not a real date and time", `${DATE_EXAMPLE}, ${DATE_OFFSET_RULE}`);
  return result;
}

/**
 * Null for anything that is not a boolean, so a COALESCE keeps the stored value when the caller
 * never mentioned the flag — while an explicit `false` still reaches the column and clears it.
 */
export function optionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value
            .filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
            .map((item) => item.trim())
        )
      ]
    : [];
}

const ANY_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A well-formed uuid, so an id that cannot name a row is refused as missing rather than failing the cast. */
export function isUuid(value: string): boolean {
  return ANY_UUID_PATTERN.test(value);
}
