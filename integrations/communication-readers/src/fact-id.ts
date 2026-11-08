import { createHash } from "node:crypto";

/**
 * The normaliser every identity hash uses. Its version is part of every hash input, and the golden vectors in
 * fact-id.test.ts pin its output: changing what it does means a new version string (and new vectors), never an edit
 * of this one, because a changed normaliser would give every stored fact a new id and orphan its statuses and labels.
 */
export const NORMALISER_VERSION = "n1";

const INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/gu;

/** n1: Unicode NFKC, invisible characters removed, lower case, whitespace runs folded to one space, trimmed. */
export function normaliseText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").toLowerCase().replace(/\s+/gu, " ").trim();
}

const sha1 = (parts: readonly unknown[]) => createHash("sha1").update(JSON.stringify(parts)).digest("hex");

export interface FactIdInput {
  /** The fact type: ask, commitment, event or deadline. */
  factType: string;
  conversationKey: string;
  /** The verbatim evidence text; normalised here. */
  evidence: string;
  icsUid?: string | null | undefined;
}

/**
 * Version-independent identity of a fact: sha1 over the normaliser version, fact type, conversation key, normalised
 * evidence and ICS uid, as a JSON array so no field can borrow characters from its neighbour. Statuses, overrides and
 * labels target this id, so it must not change when an extractor version is promoted.
 */
export function factId(input: FactIdInput): string {
  return sha1([
    "fact",
    NORMALISER_VERSION,
    input.factType,
    input.conversationKey,
    normaliseText(input.evidence),
    input.icsUid ?? null
  ]);
}

export interface ReaderEventKeyInput {
  extractor: string;
  version: string;
  sourceEventId: string;
  inputHash: string;
  evidence: string;
}

/** The `event_key` of a row a reader wrote: identity follows the evidence, not output order, so reruns are idempotent. */
export function readerEventKey(input: ReaderEventKeyInput): string {
  return sha1([
    "reader",
    input.extractor,
    input.version,
    input.sourceEventId,
    input.inputHash,
    normaliseText(input.evidence)
  ]);
}

export interface StatusEventKeyInput {
  kind: "override" | "fact_status" | "label" | (string & {});
  factId: string;
  field: string;
  newValue: unknown;
  validFrom: string;
  /** Who posted it: the agent name, or null for the person. */
  by: string | null;
}

/** Canonical JSON: object keys sorted, so equal values hash equally whatever order a client built them in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

// The same shape the ingest validator (describeTimeProblem in platform/contracts) accepts: upper-case T and Z only.
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/u;
const MIN_YEAR = 1970;
const MAX_YEAR = 2200;
const MAX_OFFSET_MINUTES = 840;

/**
 * A valid RFC 3339 instant as UTC ISO with milliseconds (`2026-11-08T01:00:00.000Z`), for every spelling the ingest
 * validator accepts (`Z`, an offset up to +-14:00, any fraction length). Anything the validator rejects (hour 24,
 * minute or second out of range, an offset past 14:00, a day that does not exist, a year outside 1970 to 2200, lower-case
 * `t` or `z`) comes back unchanged, so the hash cannot give an invalid spelling the key of a real instant. Sub-millisecond
 * digits are dropped.
 */
export function canonicalInstant(value: string): string {
  const match = RFC3339_INSTANT.exec(value);
  if (match === null) return value;
  const [year, month, day, hour, minute, second] = [1, 2, 3, 4, 5, 6].map((i) => Number(match[i]));
  const fraction = match[7];
  const offsetMinutes = match[9] === undefined ? 0 : Number(match[10]) * 60 + Number(match[11]);
  const daysInMonth = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
  const real =
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= daysInMonth &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    (match[11] === undefined || Number(match[11]) < 60) &&
    offsetMinutes <= MAX_OFFSET_MINUTES;
  if (!real) return value;
  const millis = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${(fraction ?? "").slice(0, 4).padEnd(fraction ? 4 : 0, "0")}${match[8]}`
  );
  if (Number.isNaN(millis)) return value;
  const instant = new Date(millis);
  if (instant.getUTCFullYear() < MIN_YEAR || instant.getUTCFullYear() > MAX_YEAR) return value;
  return instant.toISOString();
}

/**
 * The `event_key` of an override, fact_status or label row: the same statement made twice stores once. `validFrom`
 * is hashed as a canonical instant, so the same moment in two spellings is one key.
 */
export function statusEventKey(input: StatusEventKeyInput): string {
  return sha1([
    input.kind,
    input.factId,
    input.field,
    canonical(input.newValue),
    canonicalInstant(input.validFrom),
    input.by
  ]);
}
