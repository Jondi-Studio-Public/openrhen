import {
  WORK_LABEL_AREA_ID,
  WORK_LABEL_CORRECTED_VALUES,
  WORK_LABEL_REQUEST_ID,
  correctedLabelKey,
  resolveWorkLabels,
  type CurrentLabelInput,
  type ResolvedWorkLabel,
  type WorkLabelCorrectedValue
} from "@openrhen/contracts/drift/labels";
import { lockActivityUser } from "@/server/persistence/postgres/activity-lock";
import { readDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import {
  areaExists,
  insertWorkLabel,
  readAreaSnapshots,
  readWorkLabelRows
} from "@/server/persistence/postgres/work-label-store";
import { WORK_LABEL_PROMPT_VERSION, snapshotHash } from "./work-label-prompt";

/**
 * The owner's view of work labels: what each area counts as now (`GET /api/work-labels`) and the one-tap answer
 * (`PUT /api/work-labels/[areaId]`). A label is the owner's latest answer, else the model's label made from the area's
 * current text, else unknown (`resolveWorkLabels`). Nothing here sends or logs an area's text.
 */

export interface WorkLabelView {
  areaId: string;
  value: ResolvedWorkLabel["value"];
  origin: ResolvedWorkLabel["origin"];
  /** When the deciding row was made, as an ISO time; null when unknown. */
  at: string | null;
}

export interface WorkLabelsAnswer {
  /** Whether a local model is set, so a screen can say why a label is unknown. */
  modelConfigured: boolean;
  labels: WorkLabelView[];
}

const view = (label: ResolvedWorkLabel): WorkLabelView => ({
  areaId: label.areaId,
  value: label.value,
  origin: label.origin,
  at: label.at?.toISOString() ?? null
});

/** What each area's text is now, for the resolver. A private area is absent, so it never has an inferred label. */
export async function currentLabelInputs(
  sql: PoolSql,
  userId: string
): Promise<{ current: Map<string, CurrentLabelInput> }> {
  const snapshots = await readAreaSnapshots(sql, userId);
  return {
    current: new Map(
      snapshots.map((snapshot) => [
        snapshot.areaId,
        { inputHash: snapshotHash(snapshot), promptVersion: WORK_LABEL_PROMPT_VERSION }
      ])
    )
  };
}

export async function readWorkLabels(sql: PoolSql): Promise<WorkLabelsAnswer> {
  const userId = await ensureUser(sql);
  const [{ current }, rows, settings] = await Promise.all([
    currentLabelInputs(sql, userId),
    readWorkLabelRows(sql, userId),
    readDerivedSettings(sql)
  ]);
  const labels = resolveWorkLabels(rows, current);
  return { modelConfigured: settings.t2Model !== null, labels: [...labels.values()].map(view) };
}

export type SetWorkLabelResult = { ok: true; label: WorkLabelView } | { ok: false; status: 400 | 404; error: string };

/**
 * Stores the owner's answer for one area: `work`, `not_work`, or `unset`, which takes the answer back so the model's
 * label shows again. The request id makes a retried tap one row. Returns the label as it now reads.
 */
export async function setWorkLabel(
  sql: PoolSql,
  input: { areaId: unknown; label: unknown; requestId: unknown },
  now: Date = new Date()
): Promise<SetWorkLabelResult> {
  const { areaId, label, requestId } = input;
  if (typeof areaId !== "string" || !WORK_LABEL_AREA_ID.test(areaId))
    return {
      ok: false,
      status: 400,
      error: "The area id in the address is not an area id. Use the id the area page shows."
    };
  if (typeof label !== "string" || !(WORK_LABEL_CORRECTED_VALUES as readonly string[]).includes(label))
    return {
      ok: false,
      status: 400,
      error: `label must be one of: ${WORK_LABEL_CORRECTED_VALUES.join(", ")}. Send {"label":"work","requestId":"<a fresh id>"} again.`
    };
  if (typeof requestId !== "string" || !WORK_LABEL_REQUEST_ID.test(requestId))
    return {
      ok: false,
      status: 400,
      error:
        "requestId must be 8 to 64 letters, digits and hyphens, new for each tap (a retry of the same tap reuses it)."
    };
  const userId = await ensureUser(sql);
  if (!(await areaExists(sql, userId, areaId)))
    return { ok: false, status: 404, error: "That area is not here. It may have been removed; reload the page." };
  const written = await sql.begin(async (tx) => {
    await lockActivityUser(tx, userId);
    return insertWorkLabel(
      tx,
      userId,
      {
        id: correctedLabelKey(areaId, requestId),
        source: "drift",
        kind: "work_label",
        start: now.toISOString(),
        attrs: { area_id: areaId, label: label as WorkLabelCorrectedValue, origin: "corrected", request_id: requestId }
      },
      now
    );
  });
  if (!written.ok) return { ok: false, status: 400, error: written.reason };
  const [{ current }, rows] = await Promise.all([currentLabelInputs(sql, userId), readWorkLabelRows(sql, userId)]);
  const resolved = resolveWorkLabels(rows, current).get(areaId);
  return {
    ok: true,
    label: view(resolved ?? { areaId, value: "unknown", origin: null, at: null, rowId: null })
  };
}
