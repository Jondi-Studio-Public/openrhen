import { hardFloorReason, isClosedStatus, type ImportRecord } from "@openrhen/contracts";
import { fieldValue, isAbsentColumn } from "@/features/imports/import-validation";
import { assertNoClosedTransition } from "../close-floor";
import { ForbiddenCommandError } from "../command-errors";
import type { Sql } from "../sql-pool";

const STORED_TABLE: Partial<Record<ImportRecord["entityType"], string>> = {
  fixed_commitment: "commitments",
  fixed_commitment_recurrence: "commitment_recurrence_rules"
};

/**
 * The hard floor for an agent's import commit, or null when the
 * commit may apply. The route table cannot see a batch's rows, so they are counted here: more than the bulk
 * threshold, or any row that shares a commitment with the family calendar or changes one already shared, is
 * the person's to commit.
 */
export async function agentImportFloor(
  tx: Sql,
  userId: string,
  ready: readonly ImportRecord[]
): Promise<string | null> {
  let touchesPeople = ready.some(
    (record) => STORED_TABLE[record.entityType] && fieldValue(record, "shareToCalendar") === true
  );
  for (const [entityType, table] of Object.entries(STORED_TABLE)) {
    if (touchesPeople) break;
    const ids = ready
      .filter((record) => record.entityType === entityType && record.operation !== "create" && record.matchedEntityId)
      .map((record) => record.matchedEntityId as string);
    if (!ids.length) continue;
    const shared = await tx<{ id: string }[]>`
      SELECT id FROM ${tx(table)} WHERE user_id=${userId} AND share_to_calendar AND id::text IN ${tx(ids)} LIMIT 1`;
    touchesPeople = shared.length > 0;
  }
  return hardFloorReason({ tool: "import", action: "commit", rowCount: ready.length, touchesPeople });
}

/**
 * How many of the ready records close a commitment: a delete of one, or an update that sets a closed status. Until the
 * calendar cancel becomes a real cancel (design 7a) a delete is a hard delete, but it is counted now so the hourly brake
 * covers it from the day it changes.
 */
export function closingRecordCount(ready: readonly ImportRecord[]): number {
  return ready.filter((record) => {
    if (record.entityType !== "fixed_commitment") return false;
    if (record.operation === "delete") return true;
    return writesStatus(record) && isClosedStatus(fieldValue(record, "status") as string | undefined);
  }).length;
}

/**
 * Whether the commit writes this record's `status` into a row that already exists: an update does, and so does a link
 * that carries a differing status (the commit applies the fields the review picked as an update, `commit-records.ts`).
 * A link that picked no status, or none of its fields, leaves the commitment as it is.
 */
function writesStatus(record: ImportRecord): boolean {
  if (record.operation === "update") return true;
  if (record.operation !== "link") return false;
  if (record.relationships.sourceMatchApplyFields) return false;
  return String(record.relationships.sourceMatchDiffFields ?? "")
    .split("|")
    .includes("status");
}

/** The record kinds an import writes a status to that are also closeable rows (a commitment is counted by the brake instead). */
const CLOSEABLE_IMPORT_TYPES: ReadonlySet<ImportRecord["entityType"]> = new Set([
  "area",
  "outcome",
  "project",
  "deliverable",
  "action",
  "condition_definition",
  // closing one is counted by the brake instead, so only a born-closed create and a reopen are refused
  "fixed_commitment"
]);

/** The close type a closeable import kind is stored as. */
const CLOSE_TYPE_OF: Partial<Record<ImportRecord["entityType"], string>> = { fixed_commitment: "commitment" };

/**
 * The save floor for an agent's import commit: a record that would create a row closed, close an open one, move a
 * closed one to the other closed status, or reopen a closed one is the owner's (or a rhen_archive / rhen_cancel call's),
 * exactly as it is for a save. The import writes the record's status straight into the row, so without this an
 * import is a way round the floor. Reads the stored row, so call it inside the commit transaction.
 */
export async function assertImportNoClosedTransition(
  tx: Sql,
  userId: string,
  ready: readonly ImportRecord[]
): Promise<void> {
  for (const record of ready) {
    if (!CLOSEABLE_IMPORT_TYPES.has(record.entityType)) continue;
    if (record.operation !== "create" && !writesStatus(record)) continue;
    const sent = fieldValue(record, "status");
    // The condition upsert writes a carried but blank status cell as `active` (an absent column keeps the row's own).
    const status =
      record.entityType === "condition_definition" && !isAbsentColumn(record, "status") && !String(sent ?? "").trim()
        ? "active"
        : sent;
    if (typeof status !== "string" || !status.trim()) continue;
    try {
      await assertNoClosedTransition(
        tx,
        userId,
        CLOSE_TYPE_OF[record.entityType] ?? record.entityType,
        record.matchedEntityId ?? record.id,
        status,
        { allowClose: record.entityType === "fixed_commitment" }
      );
    } catch (error) {
      if (error instanceof ForbiddenCommandError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ForbiddenCommandError(`An agent token cannot make this write: ${message}`);
    }
  }
}
