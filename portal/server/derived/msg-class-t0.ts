import { createHash } from "node:crypto";
import { classifyMessage, readerEventKey } from "@openrhen/communication-readers";
import type { Extractor, SourceMessage } from "./extractor";

export const MSG_CLASS_T0 = "msg-class-t0";
export const MSG_CLASS_T0_VERSION = "1";

/** The attrs the classifier reads. The hash of exactly these is the input hash, so an unrelated attr changing does not mint a new row. */
const CLASSIFIER_INPUTS = [
  "list_id",
  "auto_submitted",
  "has_unsubscribe",
  "auth",
  "message_id",
  "in_reply_to",
  "ics",
  "jsonld",
  "from",
  "from_self",
  "subject"
] as const;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Tier T0 message classification over `source=gmail kind=message` rows, using the pure classifier from
 * `integrations/communication-readers`. A message the classifier cannot judge (`unknown`, no headers) gets no row; the
 * runner's cursors, not a missing row, are what stop it being read again.
 */
export const msgClassT0: Extractor = {
  name: MSG_CLASS_T0,
  version: MSG_CLASS_T0_VERSION,
  via: `extractor:${MSG_CLASS_T0}`,
  input: { source: "gmail", kind: "message" },
  extract(message: SourceMessage, now: Date) {
    if (!isPlainObject(message.attrs))
      throw new Error("The message's attrs are not an object, so it cannot be classified.");
    const result = classifyMessage(message.attrs);
    if (result.class === "unknown") return [];
    const picked = Object.fromEntries(
      CLASSIFIER_INPUTS.filter((name) => name in (message.attrs as Record<string, unknown>)).map((name) => [
        name,
        (message.attrs as Record<string, unknown>)[name]
      ])
    );
    const inputHash = createHash("sha1")
      .update(JSON.stringify(canonical(picked)))
      .digest("hex");
    const key = readerEventKey({
      extractor: MSG_CLASS_T0,
      version: MSG_CLASS_T0_VERSION,
      sourceEventId: message.key,
      inputHash,
      evidence: ""
    });
    return [
      {
        id: key,
        source: "derived",
        kind: "msg_class",
        // A bad Date header can put a message in the future, which the store refuses; the source id is in attrs anyway.
        start: new Date(Math.min(message.tsStart.getTime(), now.getTime())).toISOString(),
        attrs: {
          source_event_id: message.key,
          class: result.class,
          reasons: result.reasons,
          tier: "t0",
          extractor: MSG_CLASS_T0,
          extractor_version: MSG_CLASS_T0_VERSION
        }
      }
    ];
  }
};
