import { REASON_TAG_INFERRED_VIA, type ReasonRow, resolveReasons } from "./drift-reasons.js";

/**
 * What stands as the tags of each reason: the owner's own answer if there is one, else the local model's, else none.
 * Pure and self-contained. Tags are open-ended short phrases the owner can change freely; there is no list they come
 * from. Corrections are rows of their own (origin `corrected`), never an edit, so the model's rows stay as they were and
 * a reset simply stops the owner's answer from counting. Tags are never read by anything that plans, scores or
 * predicts (the drift features test pins that). See docs/architecture/drift.md.
 */

/** How far back reasons are tagged by the model and listed for correction. Older ones keep their words and any tags they have. */
export const REASON_TAG_WINDOW_DAYS = 14;

/** One stored `reason_tag` row, as the resolver reads it. */
export interface ReasonTagRow {
  id: string;
  checkInId: string;
  tags: readonly string[];
  origin: "inferred" | "corrected";
  /** Corrected rows only: true when the owner took their answer back. */
  reset: boolean;
  /** Inferred rows only: the prompt version and model that made the tags. */
  promptVersion: number | null;
  modelId: string | null;
  ingestedAt: Date;
  /** Null for the owner's own rows, `drift:reason-tag` for the model's. A row whose origin and writer disagree is ignored. */
  ingestedVia: string | null;
}

/** What the runner would write now. A model's tags made under anything else are stale until it runs again. */
export interface CurrentTagging {
  promptVersion: number;
  /** Null when no model is set: then no inferred row is current. */
  modelId: string | null;
}

export interface ResolvedReasonTags {
  checkInId: string;
  /** The owner's words, always returned beside the tags. */
  text: string;
  /** When the words were saved. */
  savedAt: Date;
  tags: string[];
  /** Whose tags these are: null when the reason has none. */
  origin: "corrected" | "inferred" | null;
  /** The model's tags were made under an older prompt or another model and will be replaced when it runs again; they stay until then. */
  stale: boolean;
  /** When the deciding row was stored; null when there is none. */
  at: Date | null;
  rowId: string | null;
}

/** Later wins: by the time the server stored the row, then by id, so two rows in one instant always order the same way. */
function later(a: ReasonTagRow, b: ReasonTagRow): boolean {
  const byTime = a.ingestedAt.getTime() - b.ingestedAt.getTime();
  return byTime !== 0 ? byTime > 0 : a.id > b.id;
}

function latest(rows: readonly ReasonTagRow[]): ReasonTagRow | undefined {
  let held: ReasonTagRow | undefined;
  for (const row of rows) if (held === undefined || later(row, held)) held = row;
  return held;
}

/**
 * The tags of each reason (the latest reason per check-in, from `resolveReasons`).
 *
 * - The owner's latest corrected row wins; a reset retracts it, so the model's tags show again, and an answer with no
 *   tags is still an answer. A corrected row counts only when it carries no writer stamp.
 * - Otherwise the model's tags: the latest row made under the current prompt version and model, else the latest row of
 *   any version, marked stale (so a prompt change does not blank the card while the model catches up). Rows made before
 *   the reason's current words were saved are about other words and are ignored.
 * - Otherwise none.
 *
 * A check-in with tag rows but no reason is absent from the answer.
 */
export function resolveReasonTags(
  rows: readonly ReasonTagRow[],
  reasons: readonly ReasonRow[],
  current: CurrentTagging
): Map<string, ResolvedReasonTags> {
  const byCheckIn = new Map<string, ReasonTagRow[]>();
  for (const row of rows) {
    const list = byCheckIn.get(row.checkInId);
    if (list) list.push(row);
    else byCheckIn.set(row.checkInId, [row]);
  }
  const out = new Map<string, ResolvedReasonTags>();
  for (const [checkInId, reason] of resolveReasons(reasons)) {
    const held = byCheckIn.get(checkInId) ?? [];
    const base = { checkInId, text: reason.text, savedAt: reason.ingestedAt };
    const owner = latest(held.filter((row) => row.origin === "corrected" && row.ingestedVia === null));
    if (owner !== undefined && !owner.reset) {
      out.set(checkInId, {
        ...base,
        tags: [...owner.tags],
        origin: "corrected",
        stale: false,
        at: owner.ingestedAt,
        rowId: owner.id
      });
      continue;
    }
    const made = held.filter(
      (row) =>
        row.origin === "inferred" &&
        row.ingestedVia === REASON_TAG_INFERRED_VIA &&
        row.ingestedAt.getTime() >= reason.ingestedAt.getTime()
    );
    const fresh = latest(
      made.filter((row) => row.promptVersion === current.promptVersion && row.modelId === current.modelId)
    );
    const model = fresh ?? latest(made);
    out.set(
      checkInId,
      model === undefined
        ? { ...base, tags: [], origin: null, stale: false, at: null, rowId: null }
        : {
            ...base,
            tags: [...model.tags],
            origin: "inferred",
            stale: fresh === undefined,
            at: model.ingestedAt,
            rowId: model.id
          }
    );
  }
  return out;
}

/** Whether the model should be asked about this reason now: it has no tags of its own making under the current prompt and model, and the owner has not answered. */
export function needsModelTags(resolved: ResolvedReasonTags): boolean {
  return resolved.origin !== "corrected" && (resolved.origin === null || resolved.stale);
}
