import { normalizeRepeatWeekdays } from "@openrhen/contracts";

const NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const ALIASES: Record<string, number> = { tues: 2, weds: 3, thur: 4, thurs: 4 };

/** 0 = Sunday .. 6 = Saturday for one weekday word ("Tue", "tuesday"), or null if it is not one. */
function weekdayOfWord(word: string): number | null {
  const lower = word.toLowerCase();
  const index = NAMES.findIndex((name) => name === lower || name.slice(0, 3) === lower);
  return index >= 0 ? index : (ALIASES[lower] ?? null);
}

/**
 * `Tue, Thu` -> [2, 4]: short or full names, any case, split on commas, spaces or pipes, returned in
 * the one ascending spelling a weekly rule stores. Text with a word that is not a weekday is
 * returned unchanged so validation can say what is wrong with it.
 */
export function parseImportWeekdays(text: string): number[] | string {
  const words = text.split(/[\s,|]+/).filter(Boolean);
  const days = words.map(weekdayOfWord);
  if (words.length === 0 || days.some((day) => day === null)) return text;
  return normalizeRepeatWeekdays(days as number[]);
}

/** Monday-first order, as people list them; Sunday last. */
const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/** [2, 4] -> "Tue, Thu": how a weekdays cell reads back in review and in templates. */
export function formatImportWeekdays(weekdays: readonly unknown[]): string {
  const known = MONDAY_FIRST.filter((day) => weekdays.includes(day));
  if (known.length !== weekdays.length) return weekdays.map(String).join(", ");
  return known.map((day) => NAMES[day]!.slice(0, 3).replace(/^./, (c) => c.toUpperCase())).join(", ");
}

/** "Tuesdays and Thursdays" for a weekly rule's weekdays, Monday first. */
export function pluralWeekdayNames(weekdays: readonly number[]): string {
  const names = MONDAY_FIRST.filter((day) => weekdays.includes(day)).map(
    (day) => `${NAMES[day]!.replace(/^./, (c) => c.toUpperCase())}s`
  );
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
}
