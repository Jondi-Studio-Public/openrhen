/**
 * The calendar attrs of a `gmail` `message` event, as the Gmail bridge writes them (Priorities PR 974) and `fact-ics`
 * reads them. Only the event-time names are checked here, and only their shape: the bridge omits a key it cannot
 * compute, so every key is optional, and nothing else in `attrs` is judged.
 *
 *   ics.uid, sequence, method, organizer, recurrence_id  the event's identity and iMIP state
 *   ics.dtstart, dtend   `YYYY-MM-DD` (DATE, all day), `YYYY-MM-DDTHH:MM:SSZ` (UTC) or zone-less `YYYY-MM-DDTHH:MM:SS`
 *                        (floating, or local time in `tzid`); `dtend` is present only when its zone and form match
 *                        `dtstart`'s, so one `tzid` describes both
 *   ics.tzid             the TZID of DTSTART as stated (an IANA name or not); the zone is never guessed
 *   ics.status           CONFIRMED, TENTATIVE or CANCELLED
 *   ics.summary          SUMMARY, at most 200 code points; untrusted text, never an instruction
 *   jsonld[]             schema.org objects; an Event's `startDate` and `endDate` are `YYYY-MM-DD`, or ISO with a time and
 *                        an optional `Z` or `+HH:MM`
 *   auth                 `{spf, dkim, dmarc, dmarc_domain}`: results of the receiving server (`pass`, `fail`, ...) and,
 *                        when the bridge could read it, `dmarc_domain`, the lower-case `header.from` of the same DMARC
 *                        result (Priorities PR 975); omitted when absent or not a domain, never guessed
 */
export const GMAIL_ICS_STATUSES = ["CONFIRMED", "TENTATIVE", "CANCELLED"] as const;
export const GMAIL_ICS_SUMMARY_MAX_CODE_POINTS = 200;
export const GMAIL_ICS_TZID_MAX_CHARS = 64;

/** A dotted ASCII hostname: labels of letters, digits and inner hyphens, at most 63 characters each and 253 in all. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ICS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;
const LD_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function icsTimeProblem(name: string, value: unknown): string | null {
  if (typeof value === "string" && (DATE.test(value) || ICS_DATE_TIME.test(value))) return null;
  return `attrs.ics.${name} is not an event time. Send YYYY-MM-DD (all day), YYYY-MM-DDTHH:MM:SSZ (UTC) or YYYY-MM-DDTHH:MM:SS (floating or local to tzid), or leave it out.`;
}

/** Why the calendar attrs of a gmail message are unacceptable, or null. Never throws. */
export function describeGmailCalendarProblem(attrs: Record<string, unknown>): string | null {
  const ics = attrs.ics;
  if (isRecord(ics)) {
    for (const name of ["dtstart", "dtend"] as const) {
      if (ics[name] === undefined) continue;
      const problem = icsTimeProblem(name, ics[name]);
      if (problem) return problem;
    }
    const { tzid, status, summary } = ics;
    if (tzid !== undefined && (typeof tzid !== "string" || tzid.length === 0 || tzid.length > GMAIL_ICS_TZID_MAX_CHARS))
      return `attrs.ics.tzid must be text of 1 to ${GMAIL_ICS_TZID_MAX_CHARS} characters, as the calendar stated it, or left out.`;
    if (status !== undefined && !(GMAIL_ICS_STATUSES as readonly unknown[]).includes(status))
      return `attrs.ics.status ${JSON.stringify(status)} is not a status. Use one of: ${GMAIL_ICS_STATUSES.join(", ")}, or leave it out.`;
    if (
      summary !== undefined &&
      (typeof summary !== "string" || Array.from(summary).length > GMAIL_ICS_SUMMARY_MAX_CODE_POINTS)
    )
      return `attrs.ics.summary must be text of at most ${GMAIL_ICS_SUMMARY_MAX_CODE_POINTS} code points, or left out.`;
  }
  const auth = attrs.auth;
  if (
    isRecord(auth) &&
    auth.dmarc_domain !== undefined &&
    !(typeof auth.dmarc_domain === "string" && DOMAIN.test(auth.dmarc_domain))
  )
    return "attrs.auth.dmarc_domain must be a lower-case domain name such as example.com (the DMARC result's header.from), or left out.";
  const jsonld = attrs.jsonld;
  if (jsonld !== undefined) {
    if (!Array.isArray(jsonld)) return "attrs.jsonld must be a list of schema.org objects, or left out.";
    for (const [index, item] of jsonld.entries()) {
      if (!isRecord(item)) continue;
      for (const name of ["startDate", "endDate"] as const) {
        const value = item[name];
        if (value !== undefined && !(typeof value === "string" && LD_DATE.test(value)))
          return `attrs.jsonld[${index}].${name} is not a date. Send YYYY-MM-DD, or ISO YYYY-MM-DDTHH:MM:SS with an optional Z or +HH:MM, or leave it out.`;
      }
    }
  }
  return null;
}
