import { createHash } from "node:crypto";
import {
  factIcsDrafts,
  icsCancelFactId,
  icsHeldCancelId,
  icsLookupId,
  messageFactContext,
  readerEventKey,
  type IcsFactDraft,
  type IcsHeldRow,
  type StoredIcsEvent
} from "@openrhen/communication-readers";
import type { Extractor, ExtractorLookups, RowFromKeys, SourceMessage, StoredFactRow } from "./extractor";

export const FACT_ICS = "fact-ics";
export const FACT_ICS_VERSION = "1";

/** The attrs the extractor reads. The hash of exactly these is the input hash, so an unrelated attr changing does not mint a new row. */
const INPUTS = ["auth", "from", "from_self", "thread_id", "ics", "jsonld", "list_id", "has_unsubscribe"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)])
    );
  return value;
}

const sequenceOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const addressOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const isOwnFact = (row: Record<string, unknown>): boolean => row.extractor === FACT_ICS;

/**
 * The event this extractor holds, from the rows stored under its id and under its cancels' id. The event is the own
 * event row (not a review fact, not a link) with the highest SEQUENCE, which gives the organizer and the time; the
 * sequence an update must beat is the highest of that and every applied cancel, so a replayed old update cannot bring a
 * cancelled event back. A row that never recorded a sequence counts as 0.
 */
function storedEvent(eventRows: readonly StoredFactRow[], cancelRows: readonly StoredFactRow[]): StoredIcsEvent | null {
  let best: { row: Record<string, unknown>; rank: number } | null = null;
  for (const { attrs: row } of eventRows) {
    if (!isOwnFact(row) || row.review_reason !== undefined || row.links !== undefined) continue;
    const rank = sequenceOf(row.ics_sequence) ?? 0;
    if (best === null || rank > best.rank) best = { row, rank };
  }
  if (best === null) return null;
  const cancelled = cancelRows
    .filter(({ attrs }) => isOwnFact(attrs) && Array.isArray(attrs.links))
    .map(({ attrs }) => sequenceOf(attrs.ics_sequence) ?? 0);
  const when = isRecord(best.row.when) ? best.row.when : {};
  const first = Array.isArray(when.candidates) && isRecord(when.candidates[0]) ? when.candidates[0] : {};
  return {
    sequence: Math.max(best.rank, ...cancelled),
    organizer: addressOf(best.row.ics_organizer),
    start: addressOf(first.start),
    end: addressOf(first.end)
  };
}

/** The cancels held as `unmatched_update`, as the pure rules read them back. A row with no source key is unusable. */
function heldCancels(rows: readonly StoredFactRow[]): { held: IcsHeldRow; attrs: Record<string, unknown> }[] {
  return rows.flatMap(({ attrs, start }) =>
    isOwnFact(attrs) && attrs.review_reason === "unmatched_update" && typeof attrs.source_event_id === "string"
      ? [{ held: { sourceKey: attrs.source_event_id, start, sequence: sequenceOf(attrs.ics_sequence) }, attrs }]
      : []
  );
}

function rowFor(
  message: Pick<SourceMessage, "key" | "tsStart">,
  header: { who: string[]; conversationKey: string },
  draft: IcsFactDraft,
  inputHash: string,
  now: Date
) {
  return {
    id: readerEventKey({
      extractor: FACT_ICS,
      version: FACT_ICS_VERSION,
      sourceEventId: message.key,
      inputHash,
      evidence: draft.factId
    }),
    source: "derived",
    kind: "fact",
    // A bad Date header can put a message in the future, which the store refuses; the source id is in attrs anyway.
    start: new Date(Math.min(message.tsStart.getTime(), now.getTime())).toISOString(),
    attrs: {
      source_event_id: message.key,
      fact_id: draft.factId,
      fact_type: "event",
      ...(draft.confidence !== undefined ? { confidence: draft.confidence } : {}),
      tier: "t0",
      extractor: FACT_ICS,
      extractor_version: FACT_ICS_VERSION,
      ...(draft.when !== undefined ? { when: draft.when } : {}),
      who: header.who,
      direction: "in",
      conversation_key: header.conversationKey,
      ...(draft.icsUid !== null ? { ics_uid: draft.icsUid } : {}),
      ...(draft.sequence !== null && draft.icsUid !== null ? { ics_sequence: draft.sequence } : {}),
      ...(draft.organizer !== null && draft.icsUid !== null ? { ics_organizer: draft.organizer } : {}),
      ...(draft.links !== undefined ? { links: draft.links } : {}),
      ...(draft.reviewReason !== undefined ? { review_reason: draft.reviewReason } : {})
    }
  };
}

/**
 * Tier T0 `event` facts from the calendar data the mail source reads out of a message: `attrs.ics` (an invite, an
 * update or a cancellation) and `attrs.jsonld` (schema.org events), with no model. The trust rules live in
 * `integrations/communication-readers/src/ics-event.ts`: only a DMARC pass is believed; a cancel or update applies only
 * from the original organizer with a greater SEQUENCE, otherwise it is written as a review fact that applies nothing.
 *
 * Incoming mail only (own mail carries no auth). The summary and every other text field of the calendar data are
 * untrusted and are never copied into a row. Rows are `fact` rows only, tier t0, never a `fact_status`; a cancel is a
 * `fact` with a `cancel` link, resolved by the reader at read time. The fact model extractor leaves a message this
 * extractor takes over alone (`factIcsHandles`).
 */
export const factIcs: Extractor = {
  name: FACT_ICS,
  version: FACT_ICS_VERSION,
  via: `extractor:${FACT_ICS}`,
  input: { source: "gmail", kind: "message" },
  oldestFirst: true,
  classifies: false,
  async extract(message: SourceMessage, now: Date, lookups?: ExtractorLookups) {
    if (!isRecord(message.attrs)) throw new Error("The message's attrs are not an object, so it cannot be read.");
    if (lookups === undefined)
      throw new Error("fact-ics needs the runner's lookups to read an update against its invite.");
    const attrs = message.attrs;
    const header = messageFactContext("gmail", attrs);
    if (!header.ok || header.direction !== "in") return [];

    const lookupId = icsLookupId(attrs);
    const cancelId = icsCancelFactId(attrs);
    const stored =
      lookupId === null
        ? null
        : storedEvent(await lookups.factRows(lookupId), cancelId === null ? [] : await lookups.factRows(cancelId));
    // Only a message with calendar data from a trusted sender needs the zone, so asking is deferred to the first draft.
    const input = {
      attrs,
      conversationKey: header.conversationKey,
      ownerTz: await ownerZone(attrs, lookups),
      refTime: message.tsStart.toISOString(),
      stored
    };
    let outcome = factIcsDrafts(input);
    // An event was just written: cancels held earlier (read before this invite, as a newest-first backfill does) now apply.
    let held: ReturnType<typeof heldCancels> = [];
    const heldId = outcome.drafts.some((draft) => draft.kind === "event") ? icsHeldCancelId(attrs) : null;
    if (heldId !== null) {
      held = heldCancels(await lookups.factRows(heldId));
      if (held.length > 0) outcome = factIcsDrafts({ ...input, held: held.map((entry) => entry.held) });
    }
    if (outcome.drafts.length === 0) return [];
    // The summary is untrusted text no row keeps, so a changed summary is not a changed input.
    const read = Object.fromEntries(INPUTS.filter((name) => name in attrs).map((name) => [name, attrs[name]]));
    if (isRecord(read.ics))
      read.ics = Object.fromEntries(Object.entries(read.ics).filter(([key]) => key !== "summary"));
    const inputHash = createHash("sha1")
      .update(JSON.stringify(canonical(read)))
      .digest("hex");
    const rows: (ReturnType<typeof rowFor> | RowFromKeys)[] = outcome.drafts.map((draft) =>
      rowFor(message, header, draft, inputHash, now)
    );
    for (const { sourceKey, start, draft } of outcome.resolved) {
      // Dated and sourced as the held message, whose own who and thread it carries.
      const origin = held.find((entry) => entry.held.sourceKey === sourceKey)?.attrs;
      const who = Array.isArray(origin?.who) ? (origin.who as string[]) : null;
      const conversationKey = typeof origin?.conversation_key === "string" ? origin.conversation_key : null;
      if (who === null || conversationKey === null) continue;
      const resolvedHash = createHash("sha1").update(`resolved:${sourceKey}:${draft.sequence}`).digest("hex");
      rows.push({
        event: rowFor({ key: sourceKey, tsStart: new Date(start) }, { who, conversationKey }, draft, resolvedHash, now),
        fromKeys: [sourceKey]
      });
    }
    return rows;
  }
};

/** The owner's zone, asked for only when the message holds calendar data at all. */
async function ownerZone(attrs: Record<string, unknown>, lookups: ExtractorLookups): Promise<string> {
  return isRecord(attrs.ics) || Array.isArray(attrs.jsonld) ? lookups.timeZone() : "UTC";
}
