import { hardFloorReason, isClosedStatus, type ImportRecord } from "@openrhen/contracts";
import { fieldValue } from "@/features/imports/import-validation";
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
    return record.operation === "update" && isClosedStatus(fieldValue(record, "status") as string | undefined);
  }).length;
}
