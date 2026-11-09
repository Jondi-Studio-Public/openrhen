import {
  WORK_LABEL_AREA_ID,
  WORK_LABEL_CORRECTED_VALUES,
  WORK_LABEL_EVIDENCE_MAX_CHARS,
  WORK_LABEL_INPUT_HASH,
  WORK_LABEL_MODEL_ID,
  WORK_LABEL_REQUEST_ID,
  WORK_LABEL_VALUES,
  correctedLabelKey,
  inferredLabelKey
} from "./drift/drift-labels.js";
import {
  DRIFT_RULE_IDS,
  DRIFT_THRESHOLDS_VERSION,
  flagBucket,
  holdoutAssigned,
  type DriftRuleId
} from "./drift/drift-rules.js";

/**
 * The per-kind rules for rows of source `drift`, applied at ingest to every writer by `validateActivityEvent`. Pure,
 * never throws. They check what a row can be checked against on its own (its key, its time, its closed values); who
 * wrote it is not visible here, so readers also filter on `ingested_via` and tokens cannot write the source at all
 * (`agent-routes.ts`). Beside `activity-derived.ts` rather than under `drift/` because the drift boundary test keeps
 * that folder free of imports from outside it. See docs/architecture/drift.md.
 */

export const ACTIVITY_DRIFT_ATTRS_MAX_BYTES = 4 * 1024;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const unknownAttrs = (attrs: Record<string, unknown>, allowed: readonly string[]): string | null => {
  const extra = Object.keys(attrs).find((key) => !allowed.includes(key));
  return extra === undefined
    ? null
    : `attrs "${extra.slice(0, 60)}" is not allowed here. Allowed: ${allowed.join(", ")}.`;
};

export interface DriftRowFacts {
  id: string;
  kind: string;
  tsStart: Date;
  tsEnd: Date | null;
  attrs: Record<string, unknown>;
  content: string | null;
}

/** What is wrong with a `drift` row, or null when it is fine. */
export function describeDriftProblem(row: DriftRowFacts): string | null {
  const { kind, attrs } = row;
  if ("by" in attrs) return "attrs.by is set by the server from the token that posts the row. Remove attrs.by.";
  if (row.content !== null)
    return "A drift row carries no content: words go in attrs where a kind allows them. Remove content.";
  if (row.tsEnd !== null) return "A drift row is an instant. Leave end out.";
  const bytes = new TextEncoder().encode(JSON.stringify(attrs)).length;
  if (bytes > ACTIVITY_DRIFT_ATTRS_MAX_BYTES)
    return `attrs is ${bytes} bytes; a drift row is limited to ${ACTIVITY_DRIFT_ATTRS_MAX_BYTES}.`;
  if (kind === "flag") return describeFlagProblem(row);
  if (kind === "work_label") return describeWorkLabelProblem(row);
  return `kind "${kind.slice(0, 60)}" is not open for source "drift". Use one of: flag, work_label.`;
}

function describeFlagProblem(row: DriftRowFacts): string | null {
  const { attrs } = row;
  const extra = unknownAttrs(attrs, ["rule", "moment_id", "bucket", "arm", "holdout", "thresholds_version"]);
  if (extra) return extra;
  const rule = attrs.rule;
  if (typeof rule !== "string" || !(DRIFT_RULE_IDS as readonly string[]).includes(rule))
    return `attrs.rule must be one of: ${DRIFT_RULE_IDS.join(", ")}.`;
  const momentId = attrs.moment_id;
  if (typeof momentId !== "string" || momentId.length === 0 || momentId.length > 120)
    return "attrs.moment_id must be text of 1 to 120 characters.";
  const bucket = flagBucket(row.tsStart);
  if (attrs.bucket !== bucket) return `attrs.bucket must be ${bucket}, the bucket of the flag's start time.`;
  if (attrs.arm !== "shadow") return 'attrs.arm must be "shadow": nothing is sent yet.';
  if (attrs.holdout !== holdoutAssigned(momentId))
    return "attrs.holdout must be the assignment the moment id gives; it is not a free field.";
  if (attrs.thresholds_version !== DRIFT_THRESHOLDS_VERSION)
    return `attrs.thresholds_version must be ${DRIFT_THRESHOLDS_VERSION}, the version in force.`;
  if (!row.id.endsWith(`|${rule as DriftRuleId}|${bucket}`))
    return `The event id must end with "|${rule}|${bucket}" (user|rule|bucket).`;
  return null;
}

function describeWorkLabelProblem(row: DriftRowFacts): string | null {
  const { attrs } = row;
  const origin = attrs.origin;
  if (origin !== "inferred" && origin !== "corrected") return 'attrs.origin must be "inferred" or "corrected".';
  const extra = unknownAttrs(
    attrs,
    origin === "inferred"
      ? ["area_id", "label", "origin", "model", "input_hash", "prompt_version", "evidence", "confidence"]
      : ["area_id", "label", "origin", "request_id"]
  );
  if (extra) return extra;
  const areaId = attrs.area_id;
  if (typeof areaId !== "string" || !WORK_LABEL_AREA_ID.test(areaId))
    return "attrs.area_id must be the area's id (letters, digits and hyphens).";
  const labels: readonly string[] = origin === "inferred" ? WORK_LABEL_VALUES : WORK_LABEL_CORRECTED_VALUES;
  if (typeof attrs.label !== "string" || !labels.includes(attrs.label))
    return `attrs.label must be one of: ${labels.join(", ")}${origin === "inferred" ? " (unset is the owner's alone)" : ""}.`;
  if (origin === "corrected") {
    const requestId = attrs.request_id;
    if (typeof requestId !== "string" || !WORK_LABEL_REQUEST_ID.test(requestId))
      return "attrs.request_id must be the request's id (8 to 64 letters, digits and hyphens).";
    return row.id === correctedLabelKey(areaId, requestId)
      ? null
      : `The event id must be "${correctedLabelKey(areaId, requestId)}".`;
  }
  const model = attrs.model;
  const modelId = record(model) && Object.keys(model).length === 1 ? model.id : undefined;
  if (typeof modelId !== "string" || !WORK_LABEL_MODEL_ID.test(modelId))
    return "attrs.model must be {id} naming the model that made the label.";
  const hash = attrs.input_hash;
  if (typeof hash !== "string" || !WORK_LABEL_INPUT_HASH.test(hash))
    return "attrs.input_hash must be the sha256 (64 lowercase hex characters) of what the model was shown, never the text.";
  const version = attrs.prompt_version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1000)
    return "attrs.prompt_version must be a whole number from 1.";
  const evidence = attrs.evidence;
  if (evidence !== undefined && (typeof evidence !== "string" || evidence.length > WORK_LABEL_EVIDENCE_MAX_CHARS))
    return `attrs.evidence must be text of at most ${WORK_LABEL_EVIDENCE_MAX_CHARS} characters, or left out.`;
  const confidence = attrs.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)))
    return "attrs.confidence must be a number from 0 to 1, or left out.";
  return row.id === inferredLabelKey(areaId, hash, version, modelId)
    ? null
    : `The event id must be "${inferredLabelKey(areaId, hash, version, modelId)}".`;
}
