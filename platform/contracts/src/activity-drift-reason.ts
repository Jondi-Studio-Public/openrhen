import {
  REASON_CHECK_IN_ID,
  REASON_KINDS,
  REASON_MODEL_ID,
  REASON_REQUEST_ID,
  correctedReasonTagKey,
  describeReasonTagsProblem,
  describeReasonTextProblem,
  inferredReasonTagKey,
  normaliseReasonText,
  reasonKey
} from "./drift/drift-reasons.js";

/**
 * The per-kind rules for rows of source `drift-reason`, applied at ingest to every writer by `validateActivityEvent`.
 * Pure, never throws. No message repeats the owner's words or tags: they say which field is wrong and the limit. Who
 * wrote a row is not visible here, so readers also filter on `ingested_via`, and no token can write or read the source
 * (`agent-routes.ts`). See docs/architecture/drift.md.
 */

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const unknownAttrs = (attrs: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const extra = Object.keys(attrs).find((key) => !allowed.includes(key));
  return extra === undefined
    ? null
    : `attrs "${extra.slice(0, 60)}" is not allowed here. Allowed: ${allowed.join(", ")}.`;
};

export interface DriftReasonRowFacts {
  id: string;
  kind: string;
  tsEnd: Date | null;
  attrs: Record<string, unknown>;
  content: string | null;
}

/** What is wrong with a `drift-reason` row, or null when it is fine. */
export function describeDriftReasonProblem(row: DriftReasonRowFacts): string | null {
  const { kind, attrs } = row;
  if ("by" in attrs) return "attrs.by is set by the server from the token that posts the row. Remove attrs.by.";
  if (row.content !== null) return "A drift-reason row carries no content: the words go in attrs.text. Remove content.";
  if (row.tsEnd !== null) return "A drift-reason row is an instant. Leave end out.";
  if (kind === "reason") return describeReasonProblem(row);
  if (kind === "reason_tag") return describeReasonTagProblem(row);
  return `kind "${kind.slice(0, 60)}" is not open for source "drift-reason". Use one of: ${REASON_KINDS.join(", ")}.`;
}

function checkInAndRequest(
  attrs: Record<string, unknown>
): { ok: true; checkInId: string; requestId: string } | { ok: false; problem: string } {
  const checkInId = attrs.check_in_id;
  if (typeof checkInId !== "string" || !REASON_CHECK_IN_ID.test(checkInId))
    return { ok: false, problem: "attrs.check_in_id must be the check-in's id." };
  const requestId = attrs.request_id;
  if (typeof requestId !== "string" || !REASON_REQUEST_ID.test(requestId))
    return { ok: false, problem: "attrs.request_id must be the request's id (8 to 64 letters, digits and hyphens)." };
  return { ok: true, checkInId, requestId };
}

function describeReasonProblem(row: DriftReasonRowFacts): string | null {
  const { attrs } = row;
  const extra = unknownAttrs(attrs, ["check_in_id", "text", "request_id"]);
  if (extra) return extra;
  const ids = checkInAndRequest(attrs);
  if (!ids.ok) return ids.problem;
  const text = attrs.text;
  const problem = describeReasonTextProblem(text);
  if (problem) return problem.replace("The reason", "attrs.text");
  if (text !== normaliseReasonText(text as string)) return "attrs.text must have no whitespace at either end.";
  return row.id === reasonKey(ids.checkInId, ids.requestId)
    ? null
    : `The event id must be "${reasonKey(ids.checkInId, ids.requestId)}".`;
}

function describeReasonTagProblem(row: DriftReasonRowFacts): string | null {
  const { attrs } = row;
  const origin = attrs.origin;
  if (origin !== "inferred" && origin !== "corrected") return 'attrs.origin must be "inferred" or "corrected".';
  const extra = unknownAttrs(
    attrs,
    origin === "inferred"
      ? ["check_in_id", "tags", "origin", "model", "prompt_version"]
      : ["check_in_id", "tags", "origin", "request_id", "reset"]
  );
  if (extra) return extra;
  const checkInId = attrs.check_in_id;
  if (typeof checkInId !== "string" || !REASON_CHECK_IN_ID.test(checkInId))
    return "attrs.check_in_id must be the check-in's id.";
  const tagsProblem = describeReasonTagsProblem(attrs.tags);
  if (tagsProblem) return tagsProblem;
  if (origin === "corrected") {
    const requestId = attrs.request_id;
    if (typeof requestId !== "string" || !REASON_REQUEST_ID.test(requestId))
      return "attrs.request_id must be the request's id (8 to 64 letters, digits and hyphens).";
    if (attrs.reset !== undefined && attrs.reset !== true) return "attrs.reset must be true, or left out.";
    if (attrs.reset === true && (attrs.tags as unknown[]).length > 0) return "A reset carries no tags.";
    return row.id === correctedReasonTagKey(checkInId, requestId)
      ? null
      : `The event id must be "${correctedReasonTagKey(checkInId, requestId)}".`;
  }
  const model = attrs.model;
  const modelId = record(model) && Object.keys(model).length === 1 ? model.id : undefined;
  if (typeof modelId !== "string" || !REASON_MODEL_ID.test(modelId))
    return "attrs.model must be {id} naming the model that made the tags.";
  const version = attrs.prompt_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1000)
    return "attrs.prompt_version must be a whole number from 1.";
  return row.id === inferredReasonTagKey(checkInId, version, modelId)
    ? null
    : `The event id must be "${inferredReasonTagKey(checkInId, version, modelId)}".`;
}
