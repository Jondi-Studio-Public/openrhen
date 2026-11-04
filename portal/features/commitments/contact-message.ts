/**
 * The prefilled message behind **Let Sam know?**. Everything here
 * is pure: it drafts the words and builds the `sms:`/`mailto:` links a person taps to open their own
 * messaging app with the message ready. OpenRhen never sends anything; the person presses send.
 */

/** Why the offer was made. Absent when the sheet was opened without one (the contact picked by hand). */
export type ContactMessageReason = "late" | "displaced" | "cancelled";

/** What a prefilled message needs to know, carried in the sheet's disruption preset. */
export interface ContactMessageContext {
  reason?: ContactMessageReason | undefined;
  /** "Dentist at 10:00 am", the same text as the sheet's "About …" line. */
  about?: string | undefined;
  /** Only meaningful for `late`: the engine's projected lateness, when it has one. */
  lateMinutes?: number | undefined;
}

/**
 * The first draft of the message. Deliberately plain and short: it is a starting point the person
 * edits in the sheet, not a promise of what was said. Without an `about` there is nothing specific
 * to say, so it opens with a greeting only.
 */
export function draftContactMessage(name: string, context: ContactMessageContext): string {
  const greeting = `Hi ${firstName(name)},`;
  const about = context.about?.trim();
  if (!about) return `${greeting} `;
  switch (context.reason) {
    case "late": {
      const minutes = context.lateMinutes && context.lateMinutes > 0 ? Math.round(context.lateMinutes) : 0;
      return minutes > 0
        ? `${greeting} I'm running about ${minutes} min late for ${about}.`
        : `${greeting} I'm running late for ${about}.`;
    }
    case "displaced":
      return `${greeting} something's come up and I can't make ${about}. Can we find another time?`;
    case "cancelled":
      return `${greeting} I have to cancel ${about}. Sorry about that.`;
    default:
      return `${greeting} about ${about}: `;
  }
}

/** The subject line an email uses. A text has none. */
export function contactMessageSubject(context: ContactMessageContext): string {
  const about = context.about?.trim();
  if (!about) return "Something came up";
  switch (context.reason) {
    case "late":
      return `Running late: ${about}`;
    case "cancelled":
      return `Cancelled: ${about}`;
    default:
      return `About ${about}`;
  }
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/**
 * A phone number as a person types it, reduced to what an `sms:` link can carry: digits and one
 * leading `+`. Returns `undefined` for something that is not a phone number (too few digits, or
 * letters), so a typo is caught in Settings rather than opening a text to nobody.
 */
export function normaliseContactPhone(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed || /[^\d\s()+.-]/.test(trimmed)) return undefined;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 3 || digits.length > 15) return undefined;
  return `${trimmed.startsWith("+") ? "+" : ""}${digits}`;
}

/** An email address with exactly one `@`, something either side, and no spaces; `undefined` otherwise. */
export function normaliseContactEmail(value: string): string | undefined {
  const trimmed = value.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : undefined;
}

/** The problem with a typed phone or email, for Settings and the server alike; `undefined` when fine or empty. */
export function contactAddressProblem(entry: { phone?: unknown; email?: unknown }): string | undefined {
  const phone = typeof entry.phone === "string" ? entry.phone.trim() : "";
  const email = typeof entry.email === "string" ? entry.email.trim() : "";
  if (phone && !normaliseContactPhone(phone)) return "That phone number doesn't look right.";
  if (email && !normaliseContactEmail(email)) return "That email address doesn't look right.";
  return undefined;
}

/**
 * An `sms:` link with the body filled in. `?&body=` is the form both iOS (which reads `&body=`) and
 * Android (which reads `?body=`) accept.
 */
export function smsHref(phone: string, body: string): string | undefined {
  const number = normaliseContactPhone(phone);
  return number ? `sms:${number}?&body=${encodeURIComponent(body)}` : undefined;
}

/** A `mailto:` link with the subject and body filled in. */
export function mailtoHref(email: string, subject: string, body: string): string | undefined {
  const address = normaliseContactEmail(email);
  return address
    ? `mailto:${encodeURIComponent(address).replace(/%40/g, "@")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
    : undefined;
}
