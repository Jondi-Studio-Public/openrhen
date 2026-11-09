/**
 * Sender to contact: maps the address a message came from to the contact it belongs to, and uses that
 * to break a tie between records. Pure: the caller loads the contacts. Exact address equality only, after
 * a generic clean-up (display name, angle brackets, case, a `+tag` in the local part); no domain or name
 * guessing, and two contacts with one address are ambiguous, never a pick.
 */

export interface ContactRef {
  id: string;
  email: string | null;
}

export type SenderContact = { kind: "one"; id: string } | { kind: "ambiguous"; ids: string[] } | { kind: "none" };

/** The bare lower-case address in a header value, with any `+tag` dropped from the local part; null if none. */
export function normalizeAddress(raw: string): string | null {
  const bracketed = /<([^<>]*)>/.exec(raw);
  const text = (bracketed ? bracketed[1]! : raw).trim().toLowerCase();
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1 || /\s/.test(text)) return null;
  const local = text.slice(0, at);
  const plus = local.indexOf("+");
  const bare = plus === 0 ? local : plus > 0 ? local.slice(0, plus) : local;
  return `${bare}${text.slice(at)}`;
}

/** The one contact whose email is `address`, several (ambiguous), or none. */
export function contactForSender(address: string, contacts: readonly ContactRef[]): SenderContact {
  const wanted = normalizeAddress(address);
  if (wanted === null) return { kind: "none" };
  const ids = contacts
    .filter((contact) => contact.email !== null && normalizeAddress(contact.email) === wanted)
    .map((contact) => contact.id)
    .sort();
  if (ids.length === 0) return { kind: "none" };
  return ids.length === 1 ? { kind: "one", id: ids[0]! } : { kind: "ambiguous", ids };
}

/**
 * The tied record that belongs to the sender, only when the sender is one known contact and exactly one
 * tied record carries that contact. Anything else stays a tie (null).
 */
export function breakTieByContact(
  tiedIds: readonly string[],
  records: readonly { id: string; contactId?: string | null }[],
  sender: SenderContact
): string | null {
  if (sender.kind !== "one") return null;
  const owned = tiedIds.filter((id) => records.find((record) => record.id === id)?.contactId === sender.id);
  return owned.length === 1 ? owned[0]! : null;
}
