/** At most this many recipients are kept in `who` for an outbound message. `DERIVED_MAX_WHO` in contracts is the validator's copy. */
export const MAX_WHO = 3;

export type MessageFactContextFailure = "not_gmail" | "no_thread_id" | "no_from_self" | "no_sender" | "no_recipients";

export type MessageFactContext =
  | { ok: true; direction: "in" | "out"; who: string[]; conversationKey: string }
  | { ok: false; reason: MessageFactContextFailure };

/** The address of a typed recipient, lower case: the part inside `<...>` when there is one. Used to drop repeats only. */
// Dedupe here is by the address inside <...>, case-insensitive; the contracts validator (`attrs.who`) is stricter about
// shape but only compares the whole typed string, case-insensitively. They differ on purpose: this drops repeats while
// reading headers, the validator is the last guard on what is stored.
const addressKey = (typed: string) => (/<([^<>]+)>/u.exec(typed)?.[1] ?? typed).trim().toLowerCase();
const CONTROL_OR_SEPARATOR = /[\p{Cc}\p{Zl}\p{Zp}]/u;
const usable = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 254 &&
  !CONTROL_OR_SEPARATOR.test(value) &&
  value.replace(/[\s\p{Cf}]/gu, "").length > 0;

/**
 * What a fact row records about its message that no model decides: `direction` from the collector's `from_self` (true is
 * out; the `direction` attr and anything a model says are ignored), `who` (the sender as written for `in`; up to 3
 * recipients as typed, repeats dropped by address ignoring case, for `out`) and the conversation key `gmail:<thread_id>`. A message that cannot give
 * all three yields a reason and no fact. Only `gmail` rows are read: other sources reuse the attrs shape but are not in scope.
 */
export function messageFactContext(source: string, attrs: Record<string, unknown>): MessageFactContext {
  if (source !== "gmail") return { ok: false, reason: "not_gmail" };
  const thread = attrs.thread_id;
  if (typeof thread !== "string" || !/^[^\s\p{Cc}]{1,128}$/u.test(thread)) return { ok: false, reason: "no_thread_id" };
  if (typeof attrs.from_self !== "boolean") return { ok: false, reason: "no_from_self" };
  const conversationKey = `gmail:${thread}`;
  if (!attrs.from_self) {
    if (!usable(attrs.from)) return { ok: false, reason: "no_sender" };
    return { ok: true, direction: "in", who: [attrs.from.trim()], conversationKey };
  }
  const recipients = Array.isArray(attrs.to) ? attrs.to : [];
  const seen = new Set<string>();
  const who: string[] = [];
  for (const entry of recipients) {
    if (!usable(entry) || who.length === MAX_WHO) continue;
    const key = addressKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    who.push(entry.trim());
  }
  if (who.length === 0) return { ok: false, reason: "no_recipients" };
  return { ok: true, direction: "out", who, conversationKey };
}
