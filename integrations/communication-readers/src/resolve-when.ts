import { casual as casualDe } from "chrono-node/de";
import { GB as gbEn, casual as casualEn } from "chrono-node/en";
import { casual as casualEs } from "chrono-node/es";
import { casual as casualFr } from "chrono-node/fr";
import { casual as casualIt } from "chrono-node/it";
import { casual as casualJa } from "chrono-node/ja";
import { casual as casualNl } from "chrono-node/nl";
import { casual as casualPt } from "chrono-node/pt";
import { casual as casualRu } from "chrono-node/ru";
import { casual as casualSv } from "chrono-node/sv";
import { casual as casualUk } from "chrono-node/uk";
import { hans, hant } from "chrono-node/zh";
import type { Chrono, ParsedResult } from "chrono-node";

/** The time text read for a date is at most this many code points (a grounded quote is at most 200); longer input is refused, not cut. */
export const WHEN_MAX_TEXT_CODE_POINTS = 1000;
/** Mirrors DERIVED_MAX_WHEN_CANDIDATES in platform/contracts (this package imports no workspace package). */
export const MAX_WHEN_CANDIDATES = 3;
/** Mirrors DERIVED_CONTENT_MAX_CODE_POINTS: offsets past it are not stored. */
const CONTENT_LIMIT = 200000;

export interface WhenCandidate {
  start: string;
  end?: string;
}
/** The `when` attr of a fact row, as `checkWhen` in platform/contracts validates it. */
export interface ResolvedWhen {
  raw?: [number, number];
  ref_time: string;
  tz: string;
  candidates: WhenCandidate[];
  ambiguous: boolean;
}

export type ResolveWhenFailure = "bad_ref_time" | "bad_tz" | "text_too_long";
export type ResolveWhenResult = { ok: true; when: ResolvedWhen | null } | { ok: false; reason: ResolveWhenFailure };

export interface ResolveWhenInput {
  /** The text to read a date from: the grounded quote. Never a model's date. */
  text: string;
  /** Code-point offset of `text` in the message, so `raw` points into the message. Default 0. */
  textStart?: number | undefined;
  /** When the message was sent. A date is always resolved against this, never against the clock. */
  refTime: string | Date;
  /** IANA zone the owner lives in. */
  tz: string;
  /** BCP 47 tag of the message language. Omitted means English; a language not in `WHEN_LANGUAGES` sets `ambiguous`. */
  lang?: string | null | undefined;
}

/**
 * Languages chrono-node 2.10.3 ships a parser for and this module tests (one sentence each). Anything else resolves to
 * `ambiguous: true` with no candidate. Danish, Norwegian and Polish are not covered by chrono at all.
 */
export const WHEN_LANGUAGES = ["en", "de", "fr", "es", "it", "nl", "pt", "ru", "sv", "uk", "ja", "zh"] as const;

const DAY_FIRST_REGIONS = new Set(["gb", "au", "nz", "ie", "in", "za", "sg", "hk"]);

function parserFor(tag: string): { primary: Chrono; usAlternative?: Chrono } | null {
  const parts = tag.toLowerCase().split(/[-_]/u);
  const primary = parts[0];
  switch (primary) {
    case "en":
      return parts.slice(1).some((part) => DAY_FIRST_REGIONS.has(part))
        ? { primary: gbEn }
        : { primary: casualEn, usAlternative: gbEn };
    case "de":
      return { primary: casualDe };
    case "fr":
      return { primary: casualFr };
    case "es":
      return { primary: casualEs };
    case "it":
      return { primary: casualIt };
    case "nl":
      return { primary: casualNl };
    case "pt":
      return { primary: casualPt };
    case "ru":
      return { primary: casualRu };
    case "sv":
      return { primary: casualSv };
    case "uk":
      return { primary: casualUk };
    case "ja":
      return { primary: casualJa };
    case "zh":
      // Without a script or region, simplified or traditional cannot be told apart.
      if (parts.includes("hant") || parts.includes("tw") || parts.includes("hk") || parts.includes("mo"))
        return { primary: hant.casual };
      return parts.includes("hans") || parts.includes("cn") || parts.includes("sg") ? { primary: hans.casual } : null;
    default:
      return null;
  }
}

// ---- time zone arithmetic (Intl only; no dependency) ----------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    formatters.set(tz, found);
  }
  return found;
}

/** Wall-clock parts of an instant in `tz`, as a UTC epoch of the same fields. */
function wallAsUtc(tz: string, epochMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(Math.floor(epochMs / 1000) * 1000)))
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
}
/** Offset of `tz` at an instant, in minutes east of UTC. */
const offsetMinutes = (tz: string, epochMs: number) =>
  Math.round((wallAsUtc(tz, epochMs) - Math.floor(epochMs / 1000) * 1000) / 60000);

export function rfc3339(tz: string, epochMs: number): string {
  const offset = offsetMinutes(tz, epochMs);
  const wall = new Date(epochMs + offset * 60000).toISOString().slice(0, 19);
  if (offset === 0) return `${wall}Z`;
  const abs = Math.abs(offset);
  return `${wall}${offset < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The instants at which `tz` shows this wall time. Two for a repeated time (the clocks went back), none for a skipped
 * one (the clocks went forward; `gap` is then the instant using the offset in force before the change, which reads as
 * the time pushed forward), otherwise one.
 */
export function instantsAt(tz: string, wallUtc: number): { instants: number[]; gap: boolean } {
  const before = offsetMinutes(tz, wallUtc - 86400000);
  const after = offsetMinutes(tz, wallUtc + 86400000);
  const instants = new Set<number>();
  for (const offset of new Set([before, after])) {
    const at = wallUtc - offset * 60000;
    if (offsetMinutes(tz, at) === offset) instants.add(at);
  }
  if (instants.size === 0) return { instants: [wallUtc - before * 60000], gap: true };
  return { instants: [...instants].sort((a, b) => a - b), gap: false };
}

let knownZones: ReadonlySet<string> | null = null;
/** Only IANA names the runtime lists, plus "UTC": no abbreviations ("EST"), offsets ("+05:00") or other spellings ("utc"). */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  knownZones ??= new Set([...Intl.supportedValuesOf("timeZone"), "UTC"]);
  return knownZones.has(tz);
}

/**
 * An IANA zone name the runtime can compute with, in any spelling the tz database knows: `Asia/Kolkata`, its alias
 * `Asia/Calcutta`, `America/Indiana/Indianapolis`, `Etc/GMT+11`. Unlike `validZone` (ICU's canonical list only) it
 * accepts aliases and links; it still refuses abbreviations ("EST"), offsets ("+05:00") and anything without an
 * `Area/Location` shape other than "UTC", so a zone is never guessed from a display string.
 */
export function usableZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > 64) return false;
  if (validZone(tz)) return true;
  if (!/^[A-Z][A-Za-z]*(?:\/[A-Za-z0-9_+-]+)+$/u.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ---- reading -------------------------------------------------------------------------------------------------------

const EXPLICIT_ZONE = /(?:\b[A-Z]{2,5}\b|\b(?:UTC|GMT)\s*[+-]\s*\d|[+-]\d{1,2}:?\d{2}\b|\d\s?Z\b)/u;
const TWENTY_FOUR_HOUR = /(?:^|[^\d:])(?:0\d|1[3-9]|2[0-3]):[0-5]\d/u;
/** Words that make a date a series, not an occurrence. Whole words, in the languages above that this list knows. */
const RECURRENCE =
  /\b(?:every|each|weekly|fortnightly|daily|monthly|yearly|annually|recurring|repeats?|alternate|jede[nrsm]?|jeden|w[oö]chentlich|t[aä]glich|monatlich|chaque|tous les|toutes les|hebdomadaire|cada|todos los|ogni|elke|elk|varje|cada)\b/iu;
const NUMERIC_DATE = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-]\d{2,4})?\b/u;

/** A message time must say its zone: `Z` or a numeric offset. A bare local time has no meaning to resolve against. */
const REF_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/u;
/** Zone abbreviations that name more than one zone (CST is US, China and Cuba; IST India, Ireland, Israel; BST British, Bangladesh). */
const AMBIGUOUS_ZONE = /(?<![\p{L}])(?:CST|IST|BST|AST|ACT|GST|PST|MST)(?![\p{L}])/u;
/** Phrases that look back, so the nearest past date is meant, not the next one. */
const PAST =
  /(?<![\p{L}])(?:last|past|previous|ago|yesterday|letzte[nrms]?|vergangene[nrms]?|gestern|dernier|derniere|hier|pasado|pasada|ayer|scorso|scorsa|ieri|vorige|afgelopen|gisteren|passado|passada|ontem|forra|igar|прошл\p{L}*|минул\p{L}*|вчера|вчора|昨|前の|先週|上周|上個|上个)(?![\p{L}])/iu;
/** "tonight at midnight" and "midnight tonight" mean the coming midnight, which is the start of tomorrow. */
const TONIGHT_MIDNIGHT =
  /(?<![\p{L}])(?:tonight\s+(?:at\s+)?midnight|(?:at\s+)?midnight\s+(?:tonight|this\s+evening)|tonight\s+at\s+(?:12|twelve)\s?(?:am|a\.m\.))(?![\p{L}])/iu;

const foldWord = (text: string) => text.normalize("NFKC").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
/** Whole words and stems, in every language above, that name a day, month or relative time. */
const DATE_WORD_STEMS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "january",
  "february",
  "april",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "tomorrow",
  "yesterday",
  "tonight",
  "midnight",
  "morning",
  "afternoon",
  "evening",
  "weekend",
  "fortnight",
  "between",
  "weekday",
  "montag",
  "dienstag",
  "mittwoch",
  "donnerstag",
  "freitag",
  "samstag",
  "sonntag",
  "januar",
  "februar",
  "ubermorgen",
  "gestern",
  "heute",
  "nachste",
  "letzte",
  "woche",
  "monat",
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
  "dimanche",
  "janvier",
  "fevrier",
  "avril",
  "juillet",
  "aout",
  "septembre",
  "octobre",
  "novembre",
  "decembre",
  "demain",
  "hier",
  "aujourd",
  "prochain",
  "dernier",
  "semaine",
  "lunes",
  "martes",
  "miercoles",
  "jueves",
  "viernes",
  "sabado",
  "domingo",
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
  "manana",
  "proxim",
  "pasado",
  "semana",
  "lunedi",
  "martedi",
  "mercoledi",
  "giovedi",
  "venerdi",
  "domenica",
  "gennaio",
  "febbraio",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "settembre",
  "ottobre",
  "domani",
  "prossim",
  "scorso",
  "settimana",
  "oggi",
  "ieri",
  "maandag",
  "dinsdag",
  "woensdag",
  "donderdag",
  "vrijdag",
  "zaterdag",
  "zondag",
  "februari",
  "maart",
  "augustus",
  "gisteren",
  "vandaag",
  "volgende",
  "vorige",
  "maand",
  "segunda",
  "terca",
  "quarta",
  "quinta",
  "sexta",
  "janeiro",
  "fevereiro",
  "junho",
  "julho",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
  "amanha",
  "ontem",
  "hoje",
  "passada",
  "mandag",
  "tisdag",
  "onsdag",
  "torsdag",
  "fredag",
  "lordag",
  "sondag",
  "imorgon",
  "igar",
  "idag",
  "nasta",
  "forra",
  "vecka",
  "manad"
];
const DATE_WORDS_EXACT = [
  "mon",
  "tue",
  "tues",
  "wed",
  "thu",
  "thur",
  "thurs",
  "fri",
  "sat",
  "sun",
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
  "next",
  "last",
  "coming",
  "ago",
  "today",
  "noon",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "day",
  "days",
  "now",
  "mai",
  "mars",
  "mei",
  "juni",
  "juli",
  "marz",
  "hoy",
  "ayer"
];
const DATE_WORDS_LATIN = new RegExp(
  `(?<![\\p{L}])(?:(?:${DATE_WORD_STEMS.map(foldWord).join("|")})|(?:${DATE_WORDS_EXACT.join("|")})(?![\\p{L}]))`,
  "u"
);
const DATE_WORDS_OTHER = new RegExp(
  [
    "понедельник",
    "вторник",
    "сред",
    "четверг",
    "пятниц",
    "суббот",
    "воскресень",
    "январ",
    "феврал",
    "март",
    "апрел",
    "июн",
    "июл",
    "август",
    "сентябр",
    "октябр",
    "ноябр",
    "декабр",
    "завтра",
    "послезавтра",
    "вчера",
    "сегодня",
    "следующ",
    "прошл",
    "через",
    "недел",
    "месяц",
    "полдень",
    "полночь",
    "понеділ",
    "вівтор",
    "четвер",
    "п'ятниц",
    "субот",
    "неділ",
    "січн",
    "лют",
    "берез",
    "квіт",
    "черв",
    "лип",
    "серп",
    "верес",
    "жовт",
    "листопад",
    "груд",
    "післязавтра",
    "вчора",
    "сьогодні",
    "наступн",
    "минул",
    "тиждень",
    "тижн",
    "місяц",
    "північ",
    "[来明昨後后前今週周月日年時时分半曜礼拜点點號号]"
  ]
    .map((w) => (w.startsWith("[") ? w : foldWord(w)))
    .join("|"),
  "u"
);
/** "next week at 3" names no day, so chrono's pick (the same weekday) is a guess. */
const WEEK_OR_MONTH =
  /(?<![\p{L}])(?:weeks?|months?|wochen?|monate?|semaines?|mois|semanas?|mes(?:es)?|settimana|settimane|mesi|mese|maand|vecka|manad|månad|недел\p{L}*|месяц\p{L}*|тиждень|тижн\p{L}*|місяц\p{L}*)(?![\p{L}])|[週周月]/iu;
const TIME_LIKE = /\d{1,2}\s?(?::|\.|h\b|am\b|pm\b|uhr\b|時|时|点|點)/iu;

/** "the 15th", "5th": a day of the month with no month. */
const ORDINAL_DAY = /(?<![\p{L}\d])(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)(?![\p{L}\d])/iu;
/** A month name then one or two digits and no year after: "Dec 25" is the 25th, whatever the English variant. */
const MONTH_DAY =
  /(?<![\p{L}])(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}(?:st|nd|rd|th)?(?![\d:])(?!\s*,?\s*\d{4})/iu;

/** The next date (today included) whose day of the month is `day`, as UTC year, month index and day. */
function nextDayOfMonth(refWallMs: number, day: number): { year: number; month: number } | null {
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;
  const ref = new Date(refWallMs);
  for (let ahead = 0; ahead < 14; ahead++) {
    const year = ref.getUTCFullYear();
    const month = ref.getUTCMonth() + ahead;
    const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    if (day > length) continue;
    const when = Date.UTC(year, month, day);
    if (when >= Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate())) {
      const d = new Date(when);
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
    }
  }
  return null;
}

/** The text outside the parsed spans. */
function unreadText(text: string, spans: readonly [number, number][]): string {
  let rest = "";
  let at = 0;
  for (const [from, to] of [...spans].sort((a, b) => a[0] - b[0])) {
    if (from > at) rest += text.slice(at, from) + " ";
    at = Math.max(at, to);
  }
  rest += text.slice(at);
  return rest;
}

/** Whether the text outside the parsed spans still has anything that looks like part of a date or time. */
function hasUnreadDate(rest: string): boolean {
  const folded = foldWord(rest);
  return /\d/u.test(rest) || DATE_WORDS_LATIN.test(folded) || DATE_WORDS_OTHER.test(folded);
}

interface Reading {
  index: number;
  length: number;
  candidates: WhenCandidate[];
  ambiguous: boolean;
}

const codePoints = (text: string) => Array.from(text).length;

function readResult(result: ParsedResult, tz: string, refMs: number, refShiftedMs: number): Reading | null {
  const refYear = new Date(refShiftedMs).getUTCFullYear();
  const year = result.start.get("year");
  const month = result.start.get("month");
  const day = result.start.get("day");
  if (year === null || month === null || day === null || year < 2000 || year > 2100) return null;
  const hourKnown = result.start.isCertain("hour");
  let ambiguous =
    AMBIGUOUS_ZONE.test(result.text) || (!result.start.isCertain("weekday") && WEEK_OR_MONTH.test(result.text));
  // "Nov 3" said on Nov 6 was pushed to next year by forwardDate; if the date just passed, the past one may be meant.
  if (
    !result.start.isCertain("year") &&
    result.start.isCertain("month") &&
    result.start.isCertain("day") &&
    year > refYear
  ) {
    const thisYear = Date.UTC(refYear, month - 1, day);
    if (refShiftedMs - thisYear >= 0 && refShiftedMs - thisYear <= 45 * 86400000) ambiguous = true;
  }
  const candidates: WhenCandidate[] = [];
  const push = (start: number, end?: number) => {
    const startText = rfc3339(tz, start);
    if (candidates.some((existing) => existing.start === startText)) return;
    candidates.push(end === undefined ? { start: startText } : { start: startText, end: rfc3339(tz, end) });
  };

  if (!hourKnown) {
    // A date with no time of day is an all-day reading: midnight to the next midnight, and always flagged.
    ambiguous = true;
    const startWall = Date.UTC(year, month - 1, day);
    const endWall = Date.UTC(year, month - 1, day + 1);
    push(instantsAt(tz, startWall).instants[0]!, instantsAt(tz, endWall).instants[0]!);
    return { index: result.index, length: result.text.length, candidates, ambiguous };
  }

  const explicit = result.start.isCertain("timezoneOffset") && EXPLICIT_ZONE.test(result.text);
  if (result.start.isCertain("timezoneOffset") && !explicit) {
    // A relative reading ("in 2 hours", "3 days ago") is elapsed time from the message, so no wall-clock rules apply.
    const delta = result.start.date().getTime() - refShiftedMs;
    const endDelta = result.end ? result.end.date().getTime() - refShiftedMs : undefined;
    push(refMs + delta, endDelta === undefined ? undefined : refMs + endDelta);
    return { index: result.index, length: result.text.length, candidates, ambiguous };
  }
  if (explicit) {
    // The sender named a zone: chrono's instant is exact. (The end, when there is one, is exact too.)
    push(result.start.date().getTime(), result.end?.isCertain("hour") ? result.end.date().getTime() : undefined);
    return { index: result.index, length: result.text.length, candidates, ambiguous };
  }

  const hour = result.start.get("hour") ?? 0;
  const minute = result.start.get("minute") ?? 0;
  const second = result.start.get("second") ?? 0;
  // "at 3" or "9:30" with no am/pm: both readings, the business-hours one first.
  const bareHour =
    !result.start.isCertain("meridiem") &&
    hour >= 1 &&
    hour <= 12 &&
    !TWENTY_FOUR_HOUR.test(result.text) &&
    !/\b(?:noon|midnight)\b/iu.test(result.text);
  const hours = bareHour ? (hour >= 7 && hour <= 11 ? [hour, (hour + 12) % 24] : [(hour + 12) % 24, hour]) : [hour];
  if (bareHour) ambiguous = true;
  // chrono fills an end it did not read ("9am Mon-Fri") with its default hour: keep an end only if its hour was written.
  const endRead = result.end?.isCertain("hour") === true;
  if (result.end && !endRead) ambiguous = true;
  const endHour = endRead ? result.end?.get("hour") : undefined;
  const endMinute = result.end?.get("minute") ?? 0;
  const endDay =
    result.end && endRead
      ? Date.UTC(result.end.get("year")!, result.end.get("month")! - 1, result.end.get("day")!)
      : null;
  if (hour === 0 && minute === 0 && /midnight/iu.test(result.text)) {
    // "Friday midnight" is the end of Friday, the start of Saturday; the start of Friday is the other reading.
    ambiguous = true;
    push(instantsAt(tz, Date.UTC(year, month - 1, day + 1)).instants[0]!);
  }
  for (const h of hours) {
    const wall = Date.UTC(year, month - 1, day, h, minute, second);
    const found = instantsAt(tz, wall);
    if (found.gap || found.instants.length > 1) ambiguous = true;
    for (const instant of found.instants) {
      let end: number | undefined;
      if (endDay !== null && endHour !== null && endHour !== undefined) {
        const shift = h === hour ? 0 : 12;
        const endWall = endDay + ((endHour + shift) % 24) * 3600000 + endMinute * 60000;
        end = instantsAt(tz, endWall).instants[0];
        // "10pm to 2am": an end that is not after its start is the next day's.
        if (end !== undefined && end <= instant) end = instantsAt(tz, endWall + 86400000).instants[0];
      }
      push(instant, end);
    }
  }
  return { index: result.index, length: result.text.length, candidates, ambiguous };
}

/**
 * Reads a date out of the grounded quote with a deterministic library (chrono-node), against the message's own time
 * and the owner's zone; the model never supplies a date. Returns `when: null` when the text holds none. One reading
 * with a time of day is the only case that is not `ambiguous`: a day with no time (all day), "at 3" with no am/pm, a
 * wall time the clocks skip or repeat, a numeric date that reads differently day-first and month-first ("3/4"),
 * several dates in one quote, and an unsupported language are all `ambiguous: true` with at most 3 candidates.
 * Recurrence words ("every Monday", "weekly", and their equivalents in the supported languages) set `ambiguous`; a
 * series phrased some other way is not detected, so a non-ambiguous result is not proof of a single event. Date text
 * left unread (a day number, a weekday, "next week"), a result that starts before the message with no past word, a
 * month name then a bare number ("Dec 25" is the 25th, never a year), a bare ordinal ("by the 15th" is the next 15th,
 * all day) and an end hour chrono invented are handled as the tests describe. `raw` is the offsets of the first date.
 */
export function resolveWhen(input: ResolveWhenInput): ResolveWhenResult {
  const refMs =
    input.refTime instanceof Date
      ? input.refTime.getTime()
      : typeof input.refTime === "string" && REF_TIME.test(input.refTime)
        ? Date.parse(input.refTime)
        : Number.NaN;
  if (Number.isNaN(refMs)) return { ok: false, reason: "bad_ref_time" };
  if (!validZone(input.tz)) return { ok: false, reason: "bad_tz" };
  if (
    typeof input.text !== "string" ||
    input.text.length > WHEN_MAX_TEXT_CODE_POINTS * 2 ||
    codePoints(input.text) > WHEN_MAX_TEXT_CODE_POINTS
  )
    return { ok: false, reason: "text_too_long" };
  const tz = input.tz;
  const ref_time = new Date(Math.floor(refMs / 1000) * 1000).toISOString().replace(".000Z", "Z");
  const parser = parserFor(typeof input.lang === "string" && input.lang.trim() !== "" ? input.lang.trim() : "en");
  if (parser === null) return { ok: true, when: { ref_time, tz, candidates: [], ambiguous: true } };

  // Chrono reads components in the reference's zone; give it the owner's wall clock as if it were UTC, then convert
  // each wall time back with the zone rules here. "Tomorrow" is then the owner's tomorrow, and DST is ours, not chrono's.
  const refShifted = refMs + offsetMinutes(tz, refMs) * 60000;
  const options = { forwardDate: !PAST.test(input.text) };
  const parse = (chrono: Chrono) => chrono.parse(input.text, { instant: new Date(refShifted), timezone: 0 }, options);
  const english = /^en(?:[-_]|$)/iu.test(
    typeof input.lang === "string" && input.lang.trim() !== "" ? input.lang.trim() : "en"
  );
  // The day-first English parser reads "Dec 25" as December of year 2025; month-first reads it as the 25th.
  const primary = english && MONTH_DAY.test(input.text) ? casualEn : parser.primary;
  const parsed = parse(primary);
  const spans = parsed.map((result): [number, number] => [result.index, result.index + result.text.length]);
  let readings = parsed
    .map((result) => ({ result, reading: readResult(result, tz, refMs, refShifted) }))
    .filter((entry): entry is { result: ParsedResult; reading: Reading } => entry.reading !== null);
  const tonight = TONIGHT_MIDNIGHT.exec(input.text);
  if (tonight) {
    // The coming midnight is the start of the owner's tomorrow, not the midnight that began today.
    const wall = new Date(refShifted);
    const next = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1);
    const tonightSpan: [number, number] = [tonight.index, tonight.index + tonight[0].length];
    const midnight = {
      index: tonight.index,
      length: tonight[0].length,
      candidates: [{ start: rfc3339(tz, instantsAt(tz, next).instants[0]!) }],
      ambiguous: false
    };
    readings = [{ result: parsed[0]!, reading: midnight }];
    spans.length = 0;
    spans.push(tonightSpan);
  }
  const rest = unreadText(input.text, spans);
  const unread = hasUnreadDate(rest);
  let ambiguousNumeric = RECURRENCE.test(input.text) && readings.length > 0;
  if (parser.usAlternative && primary === parser.primary) {
    // "3/4" is 3 April day-first and 3 March month-first: chrono's casual English is month-first, so add the other.
    const numeric = NUMERIC_DATE.exec(input.text);
    if (numeric && Number(numeric[1]) <= 12 && Number(numeric[2]) <= 12 && numeric[1] !== numeric[2]) {
      const other = parse(parser.usAlternative)
        .map((result) => ({ result, reading: readResult(result, tz, refMs, refShifted) }))
        .filter((entry): entry is { result: ParsedResult; reading: Reading } => entry.reading !== null);
      if (other.length > 0 && readings.length > 0) {
        ambiguousNumeric = true;
        readings = [
          {
            result: readings[0]!.result,
            reading: {
              ...readings[0]!.reading,
              candidates: [...readings[0]!.reading.candidates, ...other[0]!.reading.candidates]
            }
          },
          ...readings.slice(1)
        ];
      }
    }
  }
  const ordinal = english ? ORDINAL_DAY.exec(readings.length === 0 ? input.text : rest) : null;
  if (readings.length === 0 && ordinal) {
    // A bare day of the month: the next time that day comes round, all day, and always flagged.
    const next = nextDayOfMonth(refShifted, Number(ordinal[1]));
    if (next) {
      const day = Number(ordinal[1]);
      const startWall = Date.UTC(next.year, next.month, day);
      const endWall = Date.UTC(next.year, next.month, day + 1);
      const index = ordinal.index;
      const chars = codePoints(input.text.slice(0, index));
      const length = codePoints(ordinal[0]);
      const at = (input.textStart ?? 0) + chars;
      return {
        ok: true,
        when: {
          ...(Number.isInteger(at) && at >= 0 && at + length <= CONTENT_LIMIT
            ? { raw: [at, at + length] as [number, number] }
            : {}),
          ref_time,
          tz,
          candidates: [
            {
              start: rfc3339(tz, instantsAt(tz, startWall).instants[0]!),
              end: rfc3339(tz, instantsAt(tz, endWall).instants[0]!)
            }
          ],
          ambiguous: true
        }
      };
    }
  }
  if (readings.length === 0) {
    // Nothing was read. If the text still looks like a date (a day name, a time, a word from another language, or a
    // language this parser does not read), say so; a silent null would hide it.
    const folded = foldWord(input.text);
    const looksLikeDate =
      DATE_WORDS_LATIN.test(folded) ||
      DATE_WORDS_OTHER.test(folded) ||
      TIME_LIKE.test(input.text) ||
      /\d{1,2}(?:st|nd|rd|th)(?![\p{L}\d])/iu.test(input.text);
    return { ok: true, when: looksLikeDate ? { ref_time, tz, candidates: [], ambiguous: true } : null };
  }

  const first = readings[0]!;
  const start = (input.textStart ?? 0) + codePoints(input.text.slice(0, first.reading.index));
  const length = codePoints(input.text.slice(first.reading.index, first.reading.index + first.reading.length));
  const raw: [number, number] | undefined =
    Number.isInteger(start) && start >= 0 && start + length <= CONTENT_LIMIT && length > 0
      ? [start, start + length]
      : undefined;

  let candidates: WhenCandidate[];
  let ambiguous = first.reading.ambiguous || ambiguousNumeric || unread;
  if (readings.length === 1) {
    candidates = first.reading.candidates;
    const timeOnly = first.result.start.isCertain("hour") && !first.result.start.isCertain("day");
    const next = ordinal && timeOnly ? nextDayOfMonth(refShifted, Number(ordinal[1])) : null;
    if (next && ordinal) {
      // "due 15th at 5pm": chrono read the time and took today; the day is the unread ordinal.
      const day = Number(ordinal[1]);
      const move = (time: string) => {
        const wall = Date.UTC(
          next.year,
          next.month,
          day,
          Number(time.slice(11, 13)),
          Number(time.slice(14, 16)),
          Number(time.slice(17, 19))
        );
        return rfc3339(tz, instantsAt(tz, wall).instants[0]!);
      };
      candidates = candidates.map((c) => ({ start: move(c.start), ...(c.end ? { end: move(c.end) } : {}) }));
    } else if (ordinal) candidates = [];
  } else {
    // Several dates in one quote: the first reading of each, which is ambiguous by definition.
    ambiguous = true;
    candidates = readings.flatMap((entry) => entry.reading.candidates.slice(0, 1));
  }
  const unique = candidates.filter(
    (candidate, index) => candidates.findIndex((other) => other.start === candidate.start) === index
  );
  if (unique.length > MAX_WHEN_CANDIDATES) ambiguous = true;
  const kept = unique.slice(0, MAX_WHEN_CANDIDATES);
  if (kept.length !== 1) ambiguous = true;
  // A sure reading that lies before the message, from text with no past word, is a misread, not a fact.
  if (!ambiguous && kept.some((c) => Date.parse(c.start) < refMs) && !PAST.test(input.text)) ambiguous = true;
  return { ok: true, when: { ...(raw ? { raw } : {}), ref_time, tz, candidates: kept, ambiguous } };
}
