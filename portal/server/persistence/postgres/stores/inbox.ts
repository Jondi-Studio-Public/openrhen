import type { TxSql } from "../sql-pool";

/**
 * The inbox tables (`sources`, `captures`): unresolved intake, not plan input. This is their owner file
 * (`write-path-registry.mjs` `TABLE_OWNERS`); the other writers of these tables are moving here one slice at a time.
 */

/**
 * Keeps words as an ordinary pending capture on a source of its own. `occurredAt` marks the moment the words belong to
 * (a source's `occurred_at`), which need not be when they were saved (`createdAt`). `externalId` makes the save
 * idempotent per source type: a repeat of the same id is a no-op, so a replayed command cannot save the words twice.
 * Returns false when that source already existed.
 */
export async function insertPendingCapture(
  tx: TxSql,
  input: {
    userId: string;
    sourceType: string;
    externalId: string;
    title: string;
    text: string;
    occurredAt: Date;
    createdAt: Date;
    /** Extra marks kept with the proposal beside `text`, so a reader can tell where the words came from. */
    marks: Record<string, unknown>;
  }
): Promise<boolean> {
  const sourceId = crypto.randomUUID();
  const inserted = await tx<
    { id: string }[]
  >`INSERT INTO sources (id,user_id,source_type,external_id,title,captured_text,occurred_at,created_at) VALUES (${sourceId},${input.userId},${input.sourceType},${input.externalId},${input.title},${input.text},${input.occurredAt},${input.createdAt}) ON CONFLICT (user_id,source_type,external_id) DO NOTHING RETURNING id`;
  if (!inserted[0]) return false;
  await tx`INSERT INTO captures (id,user_id,source_id,proposal_type,status,proposed_fields,questions) VALUES (${crypto.randomUUID()},${input.userId},${sourceId},'unclassified','pending',${tx.json({ text: input.text, ...input.marks } as never)},${tx.json([] as never)})`;
  return true;
}
