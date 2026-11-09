import { hostedEligibility } from "@openrhen/communication-readers";

/**
 * The sender rule for mail the owner SENT. `hostedEligibility` checks the sender of a message; for mail he wrote, the
 * sender is himself, and the people whose privacy is at stake are the recipients. So for a `from_self` message each
 * address in To and Cc is run through the same sender rule (the versioned bank, payment, tax, health and government
 * list, and the senders he labelled sensitive) as if it had written the message. Pure; the address list and the rule
 * are the only inputs. Reasons are codes, never text.
 */

const ADDRESS = /<([^<>\s]+@[^<>\s]+)>|([^\s<>,;"]+@[^\s<>,;"]+)/gu;

/** Lower-case addresses in the To and Cc headers of a sent message; empty for mail that came in. */
export function recipientAddresses(attrs: Record<string, unknown>): string[] {
  if (attrs.from_self !== true) return [];
  const seen = new Set<string>();
  for (const field of [attrs.to, attrs.cc])
    for (const entry of Array.isArray(field) ? field : typeof field === "string" ? [field] : [])
      if (typeof entry === "string")
        for (const match of entry.matchAll(ADDRESS)) seen.add((match[1] ?? match[2] ?? "").trim().toLowerCase());
  seen.delete("");
  return [...seen];
}

/** Codes for the recipients of a sent message that the sender rule refuses; empty means none does (or it is incoming mail). */
export function recipientDenials(
  attrs: Record<string, unknown>,
  sensitiveSenders: ReadonlySet<string> | readonly string[]
): string[] {
  const denied = new Set<string>();
  for (const address of recipientAddresses(attrs)) {
    const verdict = hostedEligibility({
      message: {
        attrs: { message_id: "<probe@probe.invalid>", from: address, from_self: false },
        subject: null,
        content: "ok"
      },
      context: [],
      sensitiveSenders
    });
    for (const reason of verdict.message.reasons)
      if (reason === "sender_denied" || reason === "sender_labelled_sensitive" || reason === "no_sender")
        denied.add(`recipient_${reason}`);
  }
  return [...denied];
}
