import { createHash, randomBytes } from "node:crypto";
import type { DirectWrites } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import type { StoredAgentToken } from "./agent-token-store";

/**
 * Access tokens for the remote `/mcp` endpoint. One is minted at
 * `POST /oauth/token` from a long-lived agent token and lives an hour; only `sha256(token)` is stored. It is
 * checked against its agent token on every request, so revoking or expiring that token ends it at once.
 */

export const ACCESS_TOKEN_PREFIX = "pri_at_";
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
/** Live access tokens one agent token may hold; minting past it drops the oldest rather than failing. */
export const MAX_LIVE_ACCESS_TOKENS = 20;

export const hashAccessToken = (token: string): string => createHash("sha256").update(token).digest("hex");
export const generateAccessToken = (): string => `${ACCESS_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

export interface IssuedAccessToken {
  token: string;
  expiresAt: Date;
  scopes: string[];
}

export interface StoredAccessToken {
  id: string;
  agentTokenId: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
  /** The agent token it was minted from, as it is now (revoked or expired included). */
  agent: StoredAgentToken;
}

/**
 * Mints an access token for an agent token. It never outlives the agent token, and it is bound to one `resource`.
 * Expired rows are swept here, so the table stays the size of the live tokens without a job.
 */
export async function createAccessToken(
  sql: PoolSql,
  input: { agent: StoredAgentToken; resource: string; scopes: string[]; now?: Date }
): Promise<IssuedAccessToken> {
  const now = input.now ?? new Date();
  const userId = await ensureUser(sql);
  const token = generateAccessToken();
  const expiresAt = new Date(
    Math.min(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000, input.agent.expiresAt.getTime())
  );
  await sql`DELETE FROM agent_access_tokens WHERE expires_at < ${new Date(now.getTime() - 86_400_000)}`;
  await sql`
    INSERT INTO agent_access_tokens (user_id, agent_token_id, token_hash, resource, scopes, expires_at, created_at)
    VALUES (${userId}, ${input.agent.id}, ${hashAccessToken(token)}, ${input.resource}, ${sql.json(input.scopes as never)}, ${expiresAt}, ${now})`;
  await trimLiveAccessTokens(sql, input.agent.id, now);
  return { token, expiresAt, scopes: input.scopes };
}

/** Deletes an agent token's live access tokens beyond the newest `max`, so a client that re-requests cannot pile them up. */
export async function trimLiveAccessTokens(
  sql: PoolSql,
  agentTokenId: string,
  now: Date = new Date(),
  max: number = MAX_LIVE_ACCESS_TOKENS
): Promise<void> {
  await sql`
    DELETE FROM agent_access_tokens WHERE id IN (
      SELECT id FROM agent_access_tokens
      WHERE agent_token_id = ${agentTokenId} AND expires_at > ${now}
      ORDER BY created_at DESC, id DESC OFFSET ${max})`;
}

interface Row {
  id: string;
  agent_token_id: string;
  resource: string;
  scopes: string[];
  expires_at: Date;
  a_name: string;
  a_hash: string;
  a_scopes: string[];
  a_direct_writes: DirectWrites;
  a_expires_at: Date;
  a_revoked_at: Date | null;
}

/** The access token for a hash, joined to its agent token, or null. The caller compares hashes before trusting it. */
export async function findAccessTokenByHash(sql: PoolSql, hash: string): Promise<StoredAccessToken | null> {
  const rows = await sql<Row[]>`
    SELECT t.id, t.agent_token_id, t.resource, t.scopes, t.expires_at,
           a.name AS a_name, a.token_hash AS a_hash, a.scopes AS a_scopes, a.direct_writes AS a_direct_writes,
           a.expires_at AS a_expires_at, a.revoked_at AS a_revoked_at
    FROM agent_access_tokens t JOIN agent_tokens a ON a.id = t.agent_token_id
    WHERE t.token_hash = ${hash}`;
  const row = rows[0];
  return row
    ? {
        id: row.id,
        agentTokenId: row.agent_token_id,
        resource: row.resource,
        scopes: row.scopes,
        expiresAt: row.expires_at,
        agent: {
          id: row.agent_token_id,
          name: row.a_name,
          tokenHash: row.a_hash,
          scopes: row.a_scopes,
          directWrites: row.a_direct_writes,
          expiresAt: row.a_expires_at,
          revokedAt: row.a_revoked_at
        }
      }
    : null;
}
