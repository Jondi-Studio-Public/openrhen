import { createHash, randomBytes } from "node:crypto";
import {
  AGENT_TOKEN_PREFIX,
  type AgentTokenSummary,
  type CreateAgentToken,
  type DirectWrites,
  directWritesSchema
} from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The agent token table. Only `sha256(token)` is stored; the
 * token is returned once, by `createAgentToken`. Nothing here logs a token or a hash, and a listing never
 * carries either.
 */

export class AgentTokenError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/** A stored token as the identity check reads it. The hash stays in this module's callers' hands only. */
export interface StoredAgentToken {
  id: string;
  name: string;
  tokenHash: string;
  scopes: string[];
  directWrites: DirectWrites;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface Row {
  id: string;
  name: string;
  token_hash: string;
  scopes: string[];
  direct_writes: DirectWrites;
  expires_at: Date;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, name, token_hash, scopes, direct_writes, expires_at, created_at, last_used_at, revoked_at`;

/** sha256 of a token, as lower-case hex: what is stored and looked up. */
export const hashAgentToken = (token: string): string => createHash("sha256").update(token).digest("hex");

/** A fresh token: the prefix and 32 random bytes in base64url. */
export const generateAgentToken = (): string => `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

const summary = (row: Row): AgentTokenSummary => ({
  id: row.id,
  name: row.name,
  scopes: row.scopes,
  directWrites: row.direct_writes as AgentTokenSummary["directWrites"],
  expiresAt: row.expires_at.toISOString(),
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null
});

/** Issues a token. The raw token is in the result and nowhere else; a name already held by a live token is a 409. */
export async function createAgentToken(
  sql: PoolSql,
  input: CreateAgentToken,
  now: Date = new Date()
): Promise<{ token: string; summary: AgentTokenSummary }> {
  const userId = await ensureUser(sql);
  const token = generateAgentToken();
  const expiresAt = new Date(now.getTime() + input.expiresInDays * 86_400_000);
  try {
    const rows = await sql<Row[]>`
      INSERT INTO agent_tokens (user_id, name, token_hash, scopes, direct_writes, expires_at, created_at)
      VALUES (${userId}, ${input.name}, ${hashAgentToken(token)}, ${sql.json(input.scopes as never)}, ${sql.json(input.directWrites as never)}, ${expiresAt}, ${now})
      RETURNING ${sql.unsafe(COLUMNS)}`;
    return { token, summary: summary(rows[0]!) };
  } catch (error) {
    if ((error as { code?: string }).code === "23505")
      throw new AgentTokenError(409, `A live token named "${input.name}" already exists; revoke it first.`);
    throw error;
  }
}

/** Every token, newest first, revoked ones included so the owner sees what was ended. */
export async function listAgentTokens(sql: PoolSql): Promise<AgentTokenSummary[]> {
  const userId = await ensureUser(sql);
  const rows = await sql<Row[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM agent_tokens WHERE user_id=${userId} ORDER BY created_at DESC, id DESC`;
  return rows.map(summary);
}

/** Revokes a live token at once; the next request with it is a 401. */
export async function revokeAgentToken(sql: PoolSql, id: string, now: Date = new Date()): Promise<AgentTokenSummary> {
  const userId = await ensureUser(sql);
  const rows = await sql<Row[]>`
    UPDATE agent_tokens SET revoked_at=${now} WHERE id=${id} AND user_id=${userId} AND revoked_at IS NULL
    RETURNING ${sql.unsafe(COLUMNS)}`;
  if (rows[0]) return summary(rows[0]);
  const existing = await sql<Row[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM agent_tokens WHERE id=${id} AND user_id=${userId}`;
  if (existing[0]) return summary(existing[0]);
  throw new AgentTokenError(404, "That token does not exist.");
}

/**
 * Sets which entity classes a live token may write directly (the whole map is replaced). A revoked or expired
 * token is a 404 as far as this goes: there is nothing left to switch.
 */
export async function setAgentTokenDirectWrites(
  sql: PoolSql,
  id: string,
  directWrites: unknown,
  now: Date = new Date()
): Promise<AgentTokenSummary> {
  const parsed = directWritesSchema.safeParse(directWrites);
  if (!parsed.success) throw new AgentTokenError(400, parsed.error.issues[0]?.message ?? "directWrites is not valid.");
  const userId = await ensureUser(sql);
  const rows = await sql<Row[]>`
    UPDATE agent_tokens SET direct_writes=${sql.json(parsed.data as never)}
    WHERE id=${id} AND user_id=${userId} AND revoked_at IS NULL AND expires_at > ${now}
    RETURNING ${sql.unsafe(COLUMNS)}`;
  if (!rows[0]) throw new AgentTokenError(404, "That token does not exist or is no longer active.");
  return summary(rows[0]);
}

/** The stored token for a hash, or null. The caller compares hashes in constant time before trusting it. */
export async function findAgentTokenByHash(sql: PoolSql, hash: string): Promise<StoredAgentToken | null> {
  const rows = await sql<Row[]>`SELECT ${sql.unsafe(COLUMNS)} FROM agent_tokens WHERE token_hash=${hash}`;
  const row = rows[0];
  return row
    ? {
        id: row.id,
        name: row.name,
        tokenHash: row.token_hash,
        scopes: row.scopes,
        directWrites: row.direct_writes,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at
      }
    : null;
}

/** Records a use, at most once a minute per token however often it is called. */
export async function touchAgentToken(sql: PoolSql, id: string): Promise<void> {
  await sql`UPDATE agent_tokens SET last_used_at=now() WHERE id=${id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
}
