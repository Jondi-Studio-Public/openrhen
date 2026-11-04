import { notFoundRefusal, refusalText } from "@openrhen/contracts";
import type { DeliverableCriterionProposal } from "@/server/imports/deliverable-contract-extractor";
import { selectChatContextFiles, type RetainedSourceFile } from "@/server/imports/deliverable-source-file";
import type { PortalState } from "@/state/portal-state";
import { databaseUrl } from "@/server/runtime-env";
import "./private/index";
import { isTextlessSourceType } from "./entity-extensions";
import { sqlPool, type PoolSql, type Sql } from "./sql-pool";
import { ensureUser, NormalizedPostgresStateStore } from "./state-store";

export interface RetainSourceInput {
  deliverableId: string;
  sourceTitle: string;
  sourceType: "deliverable_text" | "deliverable_upload";
  capturedText?: string;
  contentHash: string;
  files: RetainedSourceFile[];
}

/** One retained source as the chat needs it: the captured passage and the file bytes themselves. */
export interface DeliverableChatSource {
  title: string;
  capturedText: string | null;
  files: { filename: string; mimeType: string; base64: string }[];
}

export interface PackSourceFile {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
}

export interface PackSource {
  id: string;
  title: string;
  sourceType: string;
  capturedText: string | null;
  capturedTextTruncated: boolean;
  files: PackSourceFile[];
}

const PACK_CAPTURED_TEXT_MAX_CHARS = 20_000;

export class DeliverableProposalStore {
  constructor(private readonly sql: PoolSql) {}

  private async assertOwned(deliverableId: string, userId: string): Promise<void> {
    const owned = await this.sql<{ id: string }[]>`
      SELECT d.id FROM deliverables d JOIN projects p ON p.id=d.project_id
      JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id
      WHERE d.id=${deliverableId} AND a.user_id=${userId}`;
    if (!owned[0]) throw new Error(refusalText(notFoundRefusal("deliverable", deliverableId)));
  }

  /**
   * Retains a source against the deliverable without proposing anything. This is the path the
   * workspace uses now: attaching a brief makes it available to the conversation, and any
   * requirements it implies are agreed turn by turn through the chat's own tools.
   */
  async retain(input: RetainSourceInput): Promise<PortalState> {
    const userId = await ensureUser(this.sql);
    await this.assertOwned(input.deliverableId, userId);
    await this.sql.begin(async (tx) => {
      await writeSource(tx, userId, input);
    });
    return (await new NormalizedPostgresStateStore(this.sql).get())!;
  }

  /**
   * The retained sources for one deliverable, oldest first, trimmed to what one chat turn may
   * carry. Metadata is read first so only the files that fit are pulled out of the database:
   * `content_base64` rows are large and every turn would otherwise load all of them to discard most.
   */
  async chatContext(
    deliverableId: string,
    limits: { maxFiles: number; maxTotalBytes: number; maxTextChars: number }
  ): Promise<{ sources: DeliverableChatSource[]; omittedFiles: string[] }> {
    const userId = await ensureUser(this.sql);
    await this.assertOwned(deliverableId, userId);
    const sourceRows = await this.sql<
      { id: string; title: string; source_type: string; captured_text: string | null }[]
    >`
      SELECT s.id, s.title, s.source_type, s.captured_text FROM sources s
      JOIN deliverable_sources ds ON ds.source_id=s.id
      WHERE ds.deliverable_id=${deliverableId} AND s.user_id=${userId}
      ORDER BY s.created_at, s.id`;
    if (!sourceRows.length) return { sources: [], omittedFiles: [] };
    const sourceIds = sourceRows.map((row) => row.id);
    const metadata = await this.sql<
      { id: string; source_id: string; filename: string; mime_type: string; byte_size: number }[]
    >`SELECT id, source_id, filename, mime_type, byte_size FROM source_files
      WHERE source_id = ANY(${sourceIds}) ORDER BY created_at, sort_order, id`;
    const { included, omitted } = selectChatContextFiles(
      metadata.map((row) => ({ ...row, byteSize: row.byte_size })),
      limits
    );
    const contents = included.length
      ? await this.sql<{ id: string; content_base64: string }[]>`
          SELECT id, content_base64 FROM source_files WHERE id = ANY(${included.map((file) => file.id)})`
      : [];
    const base64ById = new Map(contents.map((row) => [row.id, row.content_base64]));
    let textBudget = limits.maxTextChars;
    const sources = sourceRows.map((row) => {
      const text = isTextlessSourceType(row.source_type) ? "" : (row.captured_text?.trim() ?? "");
      const capturedText = text ? text.slice(0, Math.max(0, textBudget)) : "";
      textBudget -= capturedText.length;
      return {
        title: row.title,
        capturedText: capturedText || null,
        files: included
          .filter((file) => file.source_id === row.id && base64ById.has(file.id))
          .map((file) => ({
            filename: file.filename,
            mimeType: file.mime_type,
            base64: base64ById.get(file.id)!
          }))
      };
    });
    return { sources: sources.filter((source) => source.capturedText || source.files.length), omittedFiles: omitted };
  }

  /**
   * Every source retained against a deliverable, as the external-coordination pack needs it
   * captured text capped per source, and file METADATA only —
   * never the base64 bytes, which the CLI instead downloads through
   * `/api/deliverable-source-files/[id]` (see that route). Unlike `chatContext`, there is no shared
   * cross-source budget or file count/byte cap here: the pack is a one-shot read for a coordinator
   * that decides for itself what to fetch, not a per-turn cost paid on every model call.
   */
  async packSources(deliverableId: string): Promise<PackSource[]> {
    const userId = await ensureUser(this.sql);
    await this.assertOwned(deliverableId, userId);
    const sourceRows = await this.sql<
      { id: string; title: string; source_type: string; captured_text: string | null }[]
    >`
      SELECT s.id, s.title, s.source_type, s.captured_text FROM sources s
      JOIN deliverable_sources ds ON ds.source_id=s.id
      WHERE ds.deliverable_id=${deliverableId} AND s.user_id=${userId}
      ORDER BY s.created_at, s.id`;
    if (!sourceRows.length) return [];
    const sourceIds = sourceRows.map((row) => row.id);
    const fileRows = await this.sql<
      { id: string; source_id: string; filename: string; mime_type: string; byte_size: number }[]
    >`SELECT id, source_id, filename, mime_type, byte_size FROM source_files
      WHERE source_id = ANY(${sourceIds}) ORDER BY created_at, sort_order, id`;
    return sourceRows.map((row) => {
      if (isTextlessSourceType(row.source_type)) {
        return {
          id: row.id,
          title: row.title,
          sourceType: row.source_type,
          capturedText: null,
          capturedTextTruncated: false,
          files: fileRows
            .filter((file) => file.source_id === row.id)
            .map((file) => ({
              id: file.id,
              filename: file.filename,
              mimeType: file.mime_type,
              byteSize: file.byte_size
            }))
        };
      }
      const text = row.captured_text ?? "";
      return {
        id: row.id,
        title: row.title,
        sourceType: row.source_type,
        capturedText: text.slice(0, PACK_CAPTURED_TEXT_MAX_CHARS),
        capturedTextTruncated: text.length > PACK_CAPTURED_TEXT_MAX_CHARS,
        files: fileRows
          .filter((file) => file.source_id === row.id)
          .map((file) => ({ id: file.id, filename: file.filename, mimeType: file.mime_type, byteSize: file.byte_size }))
      };
    });
  }

  async preview(input: RetainSourceInput & { criteria: DeliverableCriterionProposal[] }): Promise<PortalState> {
    const userId = await ensureUser(this.sql);
    await this.assertOwned(input.deliverableId, userId);
    await this.sql.begin(async (tx) => {
      const sourceId = await writeSource(tx, userId, input);
      await tx`UPDATE captures SET status='superseded',reviewed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE user_id=${userId} AND source_id=${sourceId} AND matched_entity_type='deliverable' AND matched_entity_id=${input.deliverableId} AND status='pending'`;
      for (const criterion of input.criteria) {
        const fields = { ...criterion, sourceDocument: input.sourceTitle };
        const confidence =
          criterion.confidence === "high"
            ? 0.9
            : criterion.confidence === "medium"
              ? 0.6
              : criterion.confidence === "low"
                ? 0.3
                : null;
        await tx`INSERT INTO captures(user_id,source_id,proposal_type,status,proposed_fields,confidence,matched_entity_type,matched_entity_id) VALUES(${userId},${sourceId},'deliverable_criterion','pending',${tx.json(fields as never)},${confidence},'deliverable',${input.deliverableId})`;
      }
    });
    return (await new NormalizedPostgresStateStore(this.sql).get())!;
  }

  async getFile(fileId: string): Promise<{ filename: string; mimeType: string; bytes: Uint8Array } | null> {
    const userId = await ensureUser(this.sql);
    const rows = await this.sql<{ filename: string; mime_type: string; content_base64: string }[]>`
      SELECT sf.filename,sf.mime_type,sf.content_base64 FROM source_files sf
      JOIN sources s ON s.id=sf.source_id WHERE sf.id=${fileId} AND s.user_id=${userId}`;
    const file = rows[0];
    return file
      ? { filename: file.filename, mimeType: file.mime_type, bytes: base64ToBytes(file.content_base64) }
      : null;
  }
}

/** Upserts the source row, its deliverable link and its retained files. Shared by retain and preview. */
async function writeSource(tx: Sql, userId: string, input: RetainSourceInput): Promise<string> {
  const sources = await tx<{ id: string }[]>`
    INSERT INTO sources(user_id,source_type,external_id,title,captured_text,content_hash)
    VALUES(${userId},${input.sourceType},${input.contentHash},${input.sourceTitle},${input.capturedText ?? null},${input.contentHash})
    ON CONFLICT(user_id,source_type,external_id) DO UPDATE
    SET title=EXCLUDED.title,captured_text=EXCLUDED.captured_text,content_hash=EXCLUDED.content_hash
    RETURNING id`;
  const sourceId = sources[0]!.id;
  await tx`INSERT INTO deliverable_sources(deliverable_id,source_id,role) VALUES(${input.deliverableId},${sourceId},'completion_contract') ON CONFLICT DO NOTHING`;
  for (const [sortOrder, file] of input.files.entries()) {
    await tx`INSERT INTO source_files(source_id,filename,mime_type,byte_size,content_hash,content_base64,sort_order)
      VALUES(${sourceId},${file.filename},${file.mimeType},${file.bytes.byteLength},${file.contentHash},${bytesToBase64(file.bytes)},${sortOrder})
      ON CONFLICT(source_id,content_hash) DO UPDATE SET filename=EXCLUDED.filename,mime_type=EXCLUDED.mime_type,
      byte_size=EXCLUDED.byte_size,content_base64=EXCLUDED.content_base64,sort_order=EXCLUDED.sort_order`;
  }
  return sourceId;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function withDeliverableProposalStore<T>(
  operation: (store: DeliverableProposalStore) => Promise<T>
): Promise<T> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("Deliverable extraction requires PostgreSQL.");
  return operation(new DeliverableProposalStore(sqlPool(connectionString)));
}
