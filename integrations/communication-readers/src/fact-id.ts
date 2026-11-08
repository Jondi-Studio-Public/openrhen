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

/** The `event_key` of an override, fact_status or label row: the same statement made twice stores once. */
export function statusEventKey(input: StatusEventKeyInput): string {
  return sha1([input.kind, input.factId, input.field, canonical(input.newValue), input.validFrom, input.by]);
}
