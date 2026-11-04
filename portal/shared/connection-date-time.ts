/**
 * "27 Oct 2026, 2:32 pm" for the Connections cards, with the time held to its am/pm by a no-break
 * space so a narrow phone column never leaves "pm" alone at the start of the next line.
 */
import { dateTimeFormat, displayLocale } from "@/shared/locale";

export function formatConnectionDateTime(value: string | Date, timeZone?: string): string {
  const text = dateTimeFormat(displayLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone ? { timeZone } : {})
  }).format(typeof value === "string" ? new Date(value) : value);
  return text.replace(/[\s ]+([ap]m)$/i, " $1");
}
