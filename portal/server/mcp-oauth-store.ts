import { createHash, randomBytes } from "node:crypto";
import { AGENT_TOKEN_DEFAULT_EXPIRY_DAYS, allDirectWritesOn, type DirectWrites } from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";
import {
  AgentTokenError,
  createAgentToken,
  findAgentTokenByHash,
  hashAgentToken,
  type StoredAgentToken
} from "./agent-token-store";

/**
 * Storage for OAuth authorization code + PKCE on the remote `/mcp` endpoint (the design notes
 * section 4). Public clients register themselves; the owner's approval creates an ordinary agent token (its
 * secret is thrown away) and codes and refresh tokens hang off it, so revoking it ends the client at once.
 * Only `sha256` hex of a code or refresh token is stored. All four tables are left out of backups.
 *
 * "Live grant" for the client cap: a client has one while any of its code or refresh rows points at an agent
 * token that is neither revoked nor expired. `client_id` on those rows is the public id (no foreign key), so
 * evicting a client never trips over old rows.
 */

export const AUTHORIZATION_CODE_TTL_SECONDS = 120;
export const REFRESH_TOKEN_TTL_DAYS = 30;
export const MAX_OAUTH_CLIENTS = 100;
export const AUTHORIZATION_CODE_PREFIX = "pri_code_";
export const REFRESH_TOKEN_PREFIX = "pri_rt_";
export const OAUTH_CLIENT_ID_PREFIX = "pri_client_";

/** Thrown by `registerClient` when the cap is reached and every client holds a live grant. */
export class OauthStoreFull extends Error {
  constructor() {
    super("The OAuth client table is full.");
    this.name = "OauthStoreFull";
  }
}

export interface OauthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: Date;
}

export interface StoredAuthorizationCode {
  id: string;
  clientId: string;
  agentTokenId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
  consumedAt: Date | null;
  agent: StoredAgentToken;
}

export interface StoredRefreshToken {
  id: string;
  clientId: string;
  agentTokenId: string;
  resource: string;
  scopes: string[];
  expiresAt: Date;
  usedAt: Date | null;
  agent: StoredAgentToken;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
export const hashAuthorizationCode = sha256;
export const hashRefreshToken = sha256;

const DAY_MS = 86_400_000;

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: Date;
}

const toClient = (row: ClientRow): OauthClient => ({
  clientId: row.client_id,
  clientName: row.client_name,
  redirectUris: row.redirect_uris,
  createdAt: row.created_at
});

/** Registers a public client. At the cap, the oldest client with no live grant goes; if none can, `OauthStoreFull`. */
export async function registerClient(
  sql: PoolSql,
  input: { clientName: string; redirectUris: string[] },
  now: Date = new Date()
): Promise<OauthClient> {
  const userId = await ensureUser(sql);
  const n = (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM oauth_clients`)[0]!.n;
  if (n >= MAX_OAUTH_CLIENTS) {
    const evicted = await sql`
      DELETE FROM oauth_clients WHERE id = (
        SELECT c.id FROM oauth_clients c
        WHERE NOT EXISTS (
          SELECT 1 FROM (
            SELECT client_id, agent_token_id FROM oauth_authorization_codes
            UNION ALL SELECT client_id, agent_token_id FROM oauth_refresh_tokens
          ) g JOIN agent_tokens a ON a.id = g.agent_token_id
          WHERE g.client_id = c.client_id AND a.revoked_at IS NULL AND a.expires_at > ${now})
        ORDER BY c.seq ASC LIMIT 1)
      RETURNING id`;
    if (evicted.length === 0) throw new OauthStoreFull();
  }
  const clientId = `${OAUTH_CLIENT_ID_PREFIX}${randomBytes(16).toString("base64url")}`;
  const rows = await sql<ClientRow[]>`
    INSERT INTO oauth_clients (user_id, client_id, client_name, redirect_uris, created_at)
    VALUES (${userId}, ${clientId}, ${input.clientName}, ${sql.json(input.redirectUris as never)}, ${now})
    RETURNING client_id, client_name, redirect_uris, created_at`;
  return toClient(rows[0]!);
}

export async function findClient(sql: PoolSql, clientId: string): Promise<OauthClient | null> {
  const rows = await sql<ClientRow[]>`
    SELECT client_id, client_name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ${clientId}`;
  return rows[0] ? toClient(rows[0]) : null;
}

const slug = (name: string): string => {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "client";
};

/**
 * The owner approved a client: creates its agent token (`oauth-<client name>`, with a short random suffix when a live
 * token already holds the name; the secret is discarded; direct writes on for every entity class, since the owner undoes after instead of confirming before; default expiry) and returns it.
 */
export async function grantClient(
  sql: PoolSql,
  input: { client: OauthClient; scopes: string[] },
  now: Date = new Date()
): Promise<StoredAgentToken> {
  const base = `oauth-${slug(input.client.clientName)}`.slice(0, 32).replace(/-+$/, "");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = attempt === 0 ? base : `${base.slice(0, 25)}-${randomBytes(3).toString("hex")}`;
    try {
      const { token } = await createAgentToken(
        sql,
        {
          name,
          scopes: input.scopes,
          directWrites: allDirectWritesOn(),
          expiresInDays: AGENT_TOKEN_DEFAULT_EXPIRY_DAYS
        },
        now
      );
      const stored = await findAgentTokenByHash(sql, hashAgentToken(token));
      if (!stored) throw new Error("The agent token just created was not found.");
      return stored;
    } catch (error) {
      if (!(error instanceof AgentTokenError && error.status === 409)) throw error;
    }
  }
  throw new Error("Could not find a free agent token name for the client.");
}

/** Stores a single-use code for 120 seconds; the code is returned once and only its hash is kept. */
export async function createAuthorizationCode(
  sql: PoolSql,
  input: {
    clientId: string;
    agent: StoredAgentToken;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    scopes: string[];
  },
  now: Date = new Date()
): Promise<{ code: string; expiresAt: Date }> {
  const userId = await ensureUser(sql);
  const code = `${AUTHORIZATION_CODE_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(now.getTime() + AUTHORIZATION_CODE_TTL_SECONDS * 1000);
  await sql`DELETE FROM oauth_authorization_codes WHERE expires_at < ${new Date(now.getTime() - DAY_MS)}`;
  await sql`
    INSERT INTO oauth_authorization_codes
      (user_id, code_hash, client_id, agent_token_id, redirect_uri, code_challenge, resource, scopes, expires_at, created_at)
    VALUES (${userId}, ${sha256(code)}, ${input.clientId}, ${input.agent.id}, ${input.redirectUri},
            ${input.codeChallenge}, ${input.resource}, ${sql.json(input.scopes as never)}, ${expiresAt}, ${now})`;
  return { code, expiresAt };
}

interface AgentColumns {
  a_name: string;
  a_hash: string;
  a_scopes: string[];
  a_direct_writes: DirectWrites;
  a_expires_at: Date;
  a_revoked_at: Date | null;
}

const toAgent = (id: string, row: AgentColumns): StoredAgentToken => ({
  id,
  name: row.a_name,
  tokenHash: row.a_hash,
  scopes: row.a_scopes,
  directWrites: row.a_direct_writes,
  expiresAt: row.a_expires_at,
  revokedAt: row.a_revoked_at
});

interface CodeRow extends AgentColumns {
  id: string;
  client_id: string;
  agent_token_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scopes: string[];
  expires_at: Date;
  consumed_at: Date | null;
}

/**
 * Marks a code consumed and returns it as it was BEFORE this call, joined to its agent token: `consumedAt` null
 * means this call consumed it, non-null means a replay. Null when the hash is unknown. The row is locked
 * (`FOR UPDATE`) so two concurrent exchanges cannot both see it unconsumed. Expiry is the caller's check.
 */
export async function consumeAuthorizationCode(
  sql: PoolSql,
  hash: string,
  now: Date = new Date()
): Promise<StoredAuthorizationCode | null> {
  const row = await sql.begin(async (tx) => {
    const rows = await tx<CodeRow[]>`
      SELECT t.id, t.client_id, t.agent_token_id, t.redirect_uri, t.code_challenge, t.resource, t.scopes,
             t.expires_at, t.consumed_at,
             a.name AS a_name, a.token_hash AS a_hash, a.scopes AS a_scopes, a.direct_writes AS a_direct_writes,
             a.expires_at AS a_expires_at, a.revoked_at AS a_revoked_at
      FROM oauth_authorization_codes t JOIN agent_tokens a ON a.id = t.agent_token_id
      WHERE t.code_hash = ${hash}
      FOR UPDATE OF t`;
    const found = rows[0];
    if (found && found.consumed_at === null)
      await tx`UPDATE oauth_authorization_codes SET consumed_at = ${now} WHERE id = ${found.id}`;
    return found;
  });
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        agentTokenId: row.agent_token_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        resource: row.resource,
        scopes: row.scopes,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
        agent: toAgent(row.agent_token_id, row)
      }
    : null;
}

/** Issues a refresh token (30 days, never past its agent token); only its hash is stored. */
export async function issueRefreshToken(
  sql: PoolSql,
  input: { clientId: string; agent: StoredAgentToken; resource: string; scopes: string[] },
  now: Date = new Date()
): Promise<{ token: string; expiresAt: Date }> {
  const userId = await ensureUser(sql);
  const token = `${REFRESH_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(
    Math.min(now.getTime() + REFRESH_TOKEN_TTL_DAYS * DAY_MS, input.agent.expiresAt.getTime())
  );
  await sql`DELETE FROM oauth_refresh_tokens WHERE expires_at < ${new Date(now.getTime() - DAY_MS)}`;
  await sql`
    INSERT INTO oauth_refresh_tokens (user_id, token_hash, client_id, agent_token_id, resource, scopes, expires_at, created_at)
    VALUES (${userId}, ${sha256(token)}, ${input.clientId}, ${input.agent.id}, ${input.resource},
            ${sql.json(input.scopes as never)}, ${expiresAt}, ${now})`;
  return { token, expiresAt };
}

interface RefreshRow extends AgentColumns {
  id: string;
  client_id: string;
  agent_token_id: string;
  resource: string;
  scopes: string[];
  expires_at: Date;
  used_at: Date | null;
}

/** Marks a refresh token used and returns it as it was BEFORE this call, with the same rules as `consumeAuthorizationCode`. */
export async function useRefreshToken(
  sql: PoolSql,
  hash: string,
  now: Date = new Date()
): Promise<StoredRefreshToken | null> {
  const row = await sql.begin(async (tx) => {
    const rows = await tx<RefreshRow[]>`
      SELECT t.id, t.client_id, t.agent_token_id, t.resource, t.scopes, t.expires_at, t.used_at,
             a.name AS a_name, a.token_hash AS a_hash, a.scopes AS a_scopes, a.direct_writes AS a_direct_writes,
             a.expires_at AS a_expires_at, a.revoked_at AS a_revoked_at
      FROM oauth_refresh_tokens t JOIN agent_tokens a ON a.id = t.agent_token_id
      WHERE t.token_hash = ${hash}
      FOR UPDATE OF t`;
    const found = rows[0];
    if (found && found.used_at === null)
      await tx`UPDATE oauth_refresh_tokens SET used_at = ${now} WHERE id = ${found.id}`;
    return found;
  });
  return row
    ? {
        id: row.id,
        clientId: row.client_id,
        agentTokenId: row.agent_token_id,
        resource: row.resource,
        scopes: row.scopes,
        expiresAt: row.expires_at,
        usedAt: row.used_at,
        agent: toAgent(row.agent_token_id, row)
      }
    : null;
}
