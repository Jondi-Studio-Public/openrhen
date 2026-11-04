import { captures, sources } from "@openrhen/database";
import type { PortalState } from "@/state/portal-state";
import type { Row } from "../db-row";
import type { Sql } from "../sql-pool";

export async function readCaptures(sql: Sql, userId: string): Promise<PortalState["captures"]> {
  const captureRows = await sql<
    (Row<
      typeof captures,
      | "id"
      | "status"
      | "proposal_type"
      | "proposed_fields"
      | "questions"
      | "source_id"
      | "confidence"
      | "reviewed_at"
      | "version"
    > &
      Row<typeof sources, "captured_text" | "created_at" | "source_type" | "source_link"> & {
        captured_text: string;
        proposal_type: PortalState["captures"][number]["proposalType"];
        proposed_fields: Record<string, unknown>;
      })[]
  >`
      SELECT pr.id, s.captured_text, s.created_at, pr.status, pr.proposal_type, pr.proposed_fields, pr.questions,
        pr.source_id, s.source_type, s.source_link, pr.confidence, pr.reviewed_at, pr.version
      FROM captures pr JOIN sources s ON s.id = pr.source_id
      WHERE pr.user_id = ${userId} AND pr.matched_entity_type IS DISTINCT FROM 'deliverable' ORDER BY s.created_at DESC, pr.id
    `;
  return captureRows.map((row) => ({
    id: row.id,
    version: row.version,
    text: row.captured_text,
    createdAt: row.created_at.toISOString(),
    status: row.status,
    proposalType: row.proposal_type,
    proposedFields: row.proposed_fields,
    ...(Array.isArray(row.questions) && row.questions.length ? { questions: row.questions } : {}),
    sourceId: row.source_id,
    sourceType: row.source_type,
    ...(row.source_link ? { sourceLink: row.source_link } : {}),
    ...(row.confidence !== null ? { confidence: Number(row.confidence) } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at.toISOString() } : {})
  }));
}
