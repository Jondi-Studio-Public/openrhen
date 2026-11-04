import { notFoundRefusal, refusalText } from "@openrhen/contracts";
import type { ChatAttachment } from "@/server/imports/openai-deliverable-chat";
import type { CoordinationState, HandoffKind } from "@openrhen/contracts";
import { notifyStateChanged } from "@openrhen/database";
import { databaseUrl } from "@/server/runtime-env";
import { sqlPool, type PoolSql } from "./sql-pool";
import { ensureUser } from "./state-store";

export interface StoredChatMessage {
  id: string;
  role: "user" | "assistant" | "external";
  content: string;
  attachments: ChatAttachment[];
  createdAt: string;
  meta?: { kind: HandoffKind; tool: string };
}

/**
 * The Breakdown conversation for one deliverable. Deliberately outside PortalState and the command
 * pipeline: the engine never reads chat (logic-design §6), so nothing here versions, invalidates a
 * plan, or triggers a recompute.
 */
export class DeliverableChatStore {
  constructor(private readonly sql: PoolSql) {}

  private async assertOwned(deliverableId: string): Promise<string> {
    const userId = await ensureUser(this.sql);
    const owned = await this.sql<{ id: string }[]>`
      SELECT d.id FROM deliverables d JOIN projects p ON p.id=d.project_id
      JOIN outcomes o ON o.id=p.outcome_id JOIN areas a ON a.id=o.area_id
      WHERE d.id=${deliverableId} AND a.user_id=${userId}`;
    if (!owned[0]) throw new Error(refusalText(notFoundRefusal("deliverable", deliverableId)));
    return userId;
  }

  async list(deliverableId: string): Promise<StoredChatMessage[]> {
    await this.assertOwned(deliverableId);
    const rows = await this.sql<
      { id: string; role: string; content: string; attachments: unknown; meta: unknown; created_at: Date }[]
    >`SELECT id, role, content, attachments, meta, created_at FROM deliverable_chat_messages
      WHERE deliverable_id=${deliverableId} ORDER BY created_at, id`;
    return rows.map((row) => ({
      id: row.id,
      role: row.role as "user" | "assistant" | "external",
      content: row.content,
      attachments: Array.isArray(row.attachments) ? (row.attachments as ChatAttachment[]) : [],
      createdAt: row.created_at.toISOString(),
      ...(row.role === "external" && row.meta && typeof row.meta === "object"
        ? { meta: row.meta as { kind: HandoffKind; tool: string } }
        : {})
    }));
  }

  async append(
    deliverableId: string,
    role: "user" | "assistant" | "external",
    content: string,
    attachments: ChatAttachment[],
    meta?: { kind: HandoffKind; tool: string }
  ): Promise<StoredChatMessage> {
    const userId = await this.assertOwned(deliverableId);
    const rows = await this.sql<{ id: string; created_at: Date }[]>`
      INSERT INTO deliverable_chat_messages(deliverable_id, role, content, attachments, meta)
      VALUES(${deliverableId}, ${role}, ${content}, ${this.sql.json(attachments as never)}, ${this.sql.json((meta ?? {}) as never)})
      RETURNING id, created_at`;
    if (role === "external") {
      notifyStateChanged(this.sql, { userId, kind: "state" });
    }
    return {
      id: rows[0]!.id,
      role,
      content,
      attachments,
      createdAt: rows[0]!.created_at.toISOString(),
      ...(meta ? { meta } : {})
    };
  }

  async coordinationState(deliverableId: string): Promise<CoordinationState> {
    await this.assertOwned(deliverableId);
    const rows = await this.sql<{ content: string; meta: unknown; created_at: Date }[]>`
      SELECT content, meta, created_at FROM deliverable_chat_messages
      WHERE deliverable_id=${deliverableId} AND role='external'
      ORDER BY created_at DESC, id DESC`;
    const latest = rows[0];
    const latestMeta = latest?.meta as { kind: HandoffKind; tool: string } | undefined;
    const handedOff = latestMeta?.kind === "pick_up";
    const dropOff = rows.find((row) => {
      const meta = row.meta as { kind: HandoffKind } | undefined;
      return meta?.kind === "drop_off" && row.content.trim().length > 0;
    });
    return {
      handedOff,
      tool: handedOff ? (latestMeta?.tool ?? null) : null,
      since: handedOff && latest ? latest.created_at.toISOString() : null,
      lastDropOffSummary: dropOff ? dropOff.content : null
    };
  }
}

export async function withDeliverableChatStore<T>(operation: (store: DeliverableChatStore) => Promise<T>): Promise<T> {
  const connectionString = databaseUrl();
  if (!connectionString) throw new Error("The deliverable chat requires PostgreSQL.");
  return operation(new DeliverableChatStore(sqlPool(connectionString)));
}
