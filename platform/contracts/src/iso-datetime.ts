import { z } from "zod";

/** What an agent is told it may send for a date-time, and what to do when it holds a relative date. */
export const OFFSET_DATE_TIME_EXAMPLE = "2026-11-13T17:00:00-05:00";

const shown = (input: unknown): string => {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  const cut = text === undefined ? "(nothing)" : text.length > 60 ? `${text.slice(0, 60)}...` : text;
  return `"${cut}"`;
};

/**
 * The text for a date-time that is not an ISO 8601 date-time with a UTC offset: the value sent, the accepted format with
 * an example, and what to do with a relative date ("next Friday", "tomorrow"). It never guesses what a relative date
 * means; the agent works it out from `status.now` in the owner's timezone, or asks the owner when two readings fit.
 */
export function offsetDateTimeMessage(input: unknown): string {
  return (
    `${shown(input)} is not an ISO 8601 date-time with the owner's UTC offset, for example ${OFFSET_DATE_TIME_EXAMPLE}. ` +
    'Work a relative date such as "next Friday" out from status.now in the owner\'s timezone (status.timezone, from ' +
    "rhen_status); if it could mean two different days, ask the owner which. Then send the same call again with " +
    "this field corrected."
  );
}

/** `z.string().datetime({ offset: true })` whose failure says the above instead of printing a regular expression. */
export const offsetDateTime = () =>
  z.string().datetime({ offset: true, error: (issue) => offsetDateTimeMessage(issue.input) });
