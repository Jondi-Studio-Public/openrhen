/**
 * Work labels: whether an area counts as work, inferred by the local model or corrected by the owner. Pure and
 * self-contained (the drift boundary test forbids imports from outside this folder). The validator for the rows lives
 * with the other activity-source validators (`activity-drift.ts`) and reads the vocabulary and key builders below, so
 * a writer and the judge cannot disagree. Nothing here sends anything or reads the database. See docs/architecture/drift.md.
 */

/** What the model may say about an area. */
export const WORK_LABEL_VALUES = ["work", "not_work"] as const;
export type WorkLabelValue = (typeof WORK_LABEL_VALUES)[number];
/** What the owner may say: the two values, or `unset`, which retracts an earlier answer so the inferred label shows again. */
export const WORK_LABEL_CORRECTED_VALUES = [...WORK_LABEL_VALUES, "unset"] as const;
export type WorkLabelCorrectedValue = (typeof WORK_LABEL_CORRECTED_VALUES)[number];
export const WORK_LABEL_ORIGINS = ["inferred", "corrected"] as const;
export type WorkLabelOrigin = (typeof WORK_LABEL_ORIGINS)[number];

/** `ingested_via` of an inferred row. A corrected row is the person's, so its `ingested_via` is null. */
export const WORK_LABEL_INFERRED_VIA = "drift:label";

export const WORK_LABEL_EVIDENCE_MAX_CHARS = 200;
export const WORK_LABEL_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,63}$/;
export const WORK_LABEL_AREA_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const WORK_LABEL_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
export const WORK_LABEL_INPUT_HASH = /^[0-9a-f]{64}$/;

/** The key of an inferred row: one per area text, prompt version and model, so a text, prompt or model change infers again. */
export function inferredLabelKey(areaId: string, inputHash: string, promptVersion: number, modelId: string): string {
  return `work_label|${areaId}|inferred|${inputHash}|v${promptVersion}|${modelId}`;
}

/** The key of a corrected row: one per tap, named by the client's request id so a retried tap writes once. */
export function correctedLabelKey(areaId: string, requestId: string): string {
  return `work_label|${areaId}|corrected|${requestId}`;
}

/** One stored `work_label` row, as the resolver reads it. */
export interface WorkLabelRow {
  id: string;
  areaId: string;
  label: WorkLabelCorrectedValue;
  origin: WorkLabelOrigin;
  /** Inferred rows: what the model was shown, as a hash. */
  inputHash: string | null;
  promptVersion: number | null;
  tsStart: Date;
  ingestedAt: Date;
  /** Where the row came from: null for the owner's own, `drift:label` for the model's. Anything else is ignored. */
  ingestedVia: string | null;
}

/** What an area's text is now, so an inferred row counts only when it was made from this very text and prompt. */
export interface CurrentLabelInput {
  inputHash: string;
  promptVersion: number;
}

export interface ResolvedWorkLabel {
  areaId: string;
  /** `unknown` is never work. */
  value: WorkLabelValue | "unknown";
  origin: WorkLabelOrigin | null;
  /** When the deciding row was made. */
  at: Date | null;
  rowId: string | null;
}

/** Oldest first: start time, then arrival time, then id, so equal times still order the same way every read. */
function byOrder(a: WorkLabelRow, b: WorkLabelRow): number {
  return (
    a.tsStart.getTime() - b.tsStart.getTime() ||
    a.ingestedAt.getTime() - b.ingestedAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

function trusted(row: WorkLabelRow): boolean {
  if (row.origin === "corrected") return row.ingestedVia === null;
  return row.ingestedVia === WORK_LABEL_INFERRED_VIA && row.label !== "unset";
}

/**
 * The label of each area that has any row. Per area: the owner's latest answer wins whenever it was given (an
 * inferred row never overrides it), and `unset` retracts it. Without one, the latest inferred row made from the area's
 * current text and prompt counts, so a text that goes A to B and back to A is read as A's label again; with none, the
 * area is unknown. Rows from any other writer are ignored, and an area missing from `current` (private, or unreadable)
 * has no inferred label.
 */
export function resolveWorkLabels(
  rows: readonly WorkLabelRow[],
  current: ReadonlyMap<string, CurrentLabelInput>
): Map<string, ResolvedWorkLabel> {
  const byArea = new Map<string, WorkLabelRow[]>();
  for (const row of rows) {
    if (!trusted(row)) continue;
    const list = byArea.get(row.areaId);
    if (list) list.push(row);
    else byArea.set(row.areaId, [row]);
  }
  const out = new Map<string, ResolvedWorkLabel>();
  for (const [areaId, list] of byArea) {
    const sorted = [...list].sort(byOrder);
    const answer = sorted.filter((row) => row.origin === "corrected").at(-1);
    if (answer && answer.label !== "unset") {
      out.set(areaId, { areaId, value: answer.label, origin: "corrected", at: answer.tsStart, rowId: answer.id });
      continue;
    }
    const now = current.get(areaId);
    const inferred = now
      ? sorted
          .filter(
            (row) =>
              row.origin === "inferred" && row.inputHash === now.inputHash && row.promptVersion === now.promptVersion
          )
          .at(-1)
      : undefined;
    out.set(
      areaId,
      inferred && inferred.label !== "unset"
        ? { areaId, value: inferred.label, origin: "inferred", at: inferred.tsStart, rowId: inferred.id }
        : { areaId, value: "unknown", origin: null, at: null, rowId: null }
    );
  }
  return out;
}

/** The label of one area; an area with no row is unknown. */
export function labelOf(labels: ReadonlyMap<string, ResolvedWorkLabel>, areaId: string): ResolvedWorkLabel {
  return labels.get(areaId) ?? { areaId, value: "unknown", origin: null, at: null, rowId: null };
}

/**
 * The `isWorkItem` predicate rule A takes, built from resolved labels and a lookup from a planned item to its area.
 * True only for an item whose area is labelled work: not_work, unknown, and an item with no area are all false.
 */
export function workItemPredicate(
  labels: ReadonlyMap<string, ResolvedWorkLabel>,
  areaOfItem: (item: unknown) => string | undefined
): (item: unknown) => boolean {
  return (item) => {
    const areaId = areaOfItem(item);
    return areaId !== undefined && labelOf(labels, areaId).value === "work";
  };
}
