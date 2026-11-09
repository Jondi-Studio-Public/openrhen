/**
 * The calendar attrs of a mail `message` event, as the mail source writes them and `fact-ics` reads them. Only the
 * event-time and DMARC-domain names are checked here, and only their shape: the source omits a key it cannot compute, so
 * every key is optional, and nothing else in `attrs` is judged.
 *
 * A malformed calendar attr never costs the message. The offending key is dropped, the rest of the message is stored,
 * and the dropped names are recorded in `attrs.calendar_dropped` (a list such as `["ics.tzid"]`). A dropped key means
 * less is believed, never more: a dropped `dmarc_domain` leaves the sender untrusted, a dropped `tzid` leaves a floating
 * time, a dropped `dtstart` leaves no event time.
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
 *                        when the source could read it, `dmarc_domain`, the lower-case `header.from` of the same DMARC
 *                        result; omitted when absent or not a domain, never guessed
 */
export const MESSAGE_ICS_STATUSES = ["CONFIRMED", "TENTATIVE", "CANCELLED"] as const;
export const MESSAGE_ICS_SUMMARY_MAX_CODE_POINTS = 200;
export const MESSAGE_ICS_TZID_MAX_CHARS = 64;

/** A dotted ASCII hostname: labels of letters, digits and inner hyphens, at most 63 characters each and 253 in all. */
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ICS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;
const LD_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})?)?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isTime = (value: unknown): boolean =>
  typeof value === "string" && (DATE.test(value) || ICS_DATE_TIME.test(value));

/** The key `attrs.calendar_dropped` stores the names of dropped calendar attrs under. */
export const MESSAGE_CALENDAR_DROPPED_KEY = "calendar_dropped";

/**
 * The attrs of a mail message with every malformed calendar attr removed, and the names removed (`ics.tzid`,
 * `jsonld[0].startDate`, `auth.dmarc_domain`, ...). Returns the same object when nothing is wrong. Never throws, never
 * rejects: a calendar quirk must not lose the message. A removed `ics.dtstart` takes `ics.dtend` with it, because an end
 * is only meaningful in the form and zone of its start.
 */
export function sanitizeMessageCalendarAttrs(attrs: Record<string, unknown>): {
  attrs: Record<string, unknown>;
  dropped: string[];
} {
  const dropped: string[] = [];
  const out: Record<string, unknown> = { ...attrs };
  const ics = attrs.ics;
  if (isRecord(ics)) {
    const next: Record<string, unknown> = { ...ics };
    const drop = (name: string) => {
      if (name in next) {
        delete next[name];
        dropped.push(`ics.${name}`);
      }
    };
    if (next.dtstart !== undefined && !isTime(next.dtstart)) {
      drop("dtstart");
      drop("dtend");
    }
    if (next.dtend !== undefined && !isTime(next.dtend)) drop("dtend");
    const { tzid, status, summary } = next;
    if (
      tzid !== undefined &&
      (typeof tzid !== "string" || tzid.length === 0 || tzid.length > MESSAGE_ICS_TZID_MAX_CHARS)
    )
      drop("tzid");
    if (status !== undefined && !(MESSAGE_ICS_STATUSES as readonly unknown[]).includes(status)) drop("status");
    if (
      summary !== undefined &&
      (typeof summary !== "string" || Array.from(summary).length > MESSAGE_ICS_SUMMARY_MAX_CODE_POINTS)
    )
      drop("summary");
    out.ics = next;
  }
  const auth = attrs.auth;
  if (
    isRecord(auth) &&
    auth.dmarc_domain !== undefined &&
    !(typeof auth.dmarc_domain === "string" && DOMAIN.test(auth.dmarc_domain))
  ) {
    const { dmarc_domain: _gone, ...rest } = auth;
    out.auth = rest;
    dropped.push("auth.dmarc_domain");
  }
  const jsonld = attrs.jsonld;
  if (jsonld !== undefined) {
    if (!Array.isArray(jsonld)) {
      delete out.jsonld;
      dropped.push("jsonld");
    } else {
      out.jsonld = jsonld.map((item, index) => {
        if (!isRecord(item)) return item;
        const next: Record<string, unknown> = { ...item };
        for (const name of ["startDate", "endDate"] as const) {
          const value = next[name];
          if (value !== undefined && !(typeof value === "string" && LD_DATE.test(value))) {
            delete next[name];
            dropped.push(`jsonld[${index}].${name}`);
          }
        }
        return next;
      });
    }
  }
  if (dropped.length === 0) return { attrs, dropped };
  return { attrs: { ...out, [MESSAGE_CALENDAR_DROPPED_KEY]: dropped }, dropped };
}
