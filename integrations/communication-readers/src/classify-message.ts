/**
 * Mirrors DERIVED_MSG_CLASSES and DERIVED_MSG_CLASS_REASONS in platform/contracts (this package imports no workspace
 * package); change both together. The reason order here is the order `reasons` is returned in.
 */
export const MSG_CLASSES = ["person", "bulk", "automated", "transaction", "calendar"] as const;
export type MsgClass = (typeof MSG_CLASSES)[number];
export const MSG_CLASS_REASONS = [
  "ics_present",
  "jsonld_event",
  "jsonld_order",
  "receipt_subject",
  "auto_submitted",
  "list_id",
  "unsubscribe_header",
  "noreply_sender",
  "auth_failed",
  "in_reply_to",
  "from_self",
  "no_automation_signals"
] as const;
export type MsgClassReason = (typeof MSG_CLASS_REASONS)[number];

export interface MessageClassification {
  /** `unknown` is never stored as a msg_class row; it means the inputs were missing. */
  class: MsgClass | "unknown";
  reasons: (MsgClassReason | "no_headers")[];
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0
    ? (value as Record<string, unknown>)
    : null;

const NOREPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster)$/iu;
const RECEIPT = /\b(?:receipt|invoice|order confirmation|your order|payment received|payment confirmation)\b/iu;

function senderLocalPart(from: unknown): string | null {
  const value = text(from);
  if (value === null) return null;
  const address = /<([^>]+)>/u.exec(value)?.[1] ?? value;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(0, at).trim() : null;
}

/** The types in `attrs.jsonld`: the bridge writes an array of objects keyed `@type`; one object, or `type`, is tolerated. */
function jsonldTypes(value: unknown): string[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
    const raw = (item as Record<string, unknown>)["@type"] ?? (item as Record<string, unknown>).type;
    return (Array.isArray(raw) ? raw : [raw]).filter((type): type is string => typeof type === "string");
  });
}
const AUTH_FAILURES = new Set(["fail", "softfail", "permerror"]);

/**
 * Tier T0 of the message classifier: headers and sender only, plain code, no model. `attrs` is a gmail-shaped row's
 * attrs: `list_id`, `auto_submitted`, `has_unsubscribe`, `auth {spf,dkim,dmarc}`, `message_id`, `in_reply_to`,
 * `ics {...}`, `jsonld [{"@type": ...}]`, plus `from`, `from_self` and `subject`. When none of the header inputs is present (empty
 * attrs, a chat source, a bridge that has not parsed headers) the answer is `unknown` with reason `no_headers`, never
 * `person`. In practice `message_id` is the marker that the bridge parsed headers (nearly every mail has one); only
 * `has_unsubscribe: true` counts, since `false` says nothing. `auth_failed` (fail, softfail, permerror) is a reason
 * only and never changes the class, so a downstream rule must not auto-act on it alone. A guess here would train and act on mail nobody looked at. Strongest class wins: calendar, transaction,
 * automated, bulk, person. Never throws.
 */
export function classifyMessage(attrs: Record<string, unknown>): MessageClassification {
  const listId = text(attrs.list_id);
  const autoSubmitted = text(attrs.auto_submitted);
  const unsubscribe = attrs.has_unsubscribe === true ? true : null;
  const auth = record(attrs.auth);
  const messageId = text(attrs.message_id);
  const inReplyTo = text(attrs.in_reply_to);
  const ics = record(attrs.ics);
  const jsonldTypeList = jsonldTypes(attrs.jsonld).map((type) => type.toLowerCase());

  if (
    listId === null &&
    autoSubmitted === null &&
    unsubscribe === null &&
    auth === null &&
    messageId === null &&
    inReplyTo === null &&
    ics === null &&
    jsonldTypeList.length === 0
  )
    return { class: "unknown", reasons: ["no_headers"] };

  const reasons = new Set<MsgClassReason>();
  if (ics) reasons.add("ics_present");
  const types = jsonldTypeList;
  if (types.some((type) => type.includes("event") || type.includes("reservation"))) reasons.add("jsonld_event");
  if (types.some((type) => type.includes("order") || type.includes("invoice") || type.includes("receipt")))
    reasons.add("jsonld_order");
  if (autoSubmitted !== null && autoSubmitted.trim().toLowerCase() !== "no") reasons.add("auto_submitted");
  if (listId !== null) reasons.add("list_id");
  if (unsubscribe === true) reasons.add("unsubscribe_header");
  const local = senderLocalPart(attrs.from);
  if (local !== null && NOREPLY.test(local)) reasons.add("noreply_sender");
  // A receipt-like subject only counts on mail that is already machine-sent; a person asking "receipt?" is a person.
  const machineSent = ["noreply_sender", "auto_submitted", "list_id", "unsubscribe_header"].some((r) =>
    reasons.has(r as MsgClassReason)
  );
  const subject = text(attrs.subject);
  if (machineSent && subject !== null && RECEIPT.test(subject)) reasons.add("receipt_subject");
  if (auth && ["spf", "dkim", "dmarc"].some((key) => typeof auth[key] === "string" && AUTH_FAILURES.has(auth[key])))
    reasons.add("auth_failed");

  let cls: MsgClass;
  if (reasons.has("ics_present") || reasons.has("jsonld_event")) cls = "calendar";
  else if (reasons.has("jsonld_order") || reasons.has("receipt_subject")) cls = "transaction";
  else if (reasons.has("auto_submitted") || reasons.has("noreply_sender")) cls = "automated";
  else if (reasons.has("list_id") || reasons.has("unsubscribe_header")) cls = "bulk";
  else {
    cls = "person";
    if (inReplyTo !== null) reasons.add("in_reply_to");
    if (attrs.from_self === true) reasons.add("from_self");
    if (!reasons.has("in_reply_to") && !reasons.has("from_self")) reasons.add("no_automation_signals");
  }
  return { class: cls, reasons: MSG_CLASS_REASONS.filter((reason) => reasons.has(reason)) };
}
