import { createHash, randomBytes } from "node:crypto";
import {
  OWNER_SESSION_DAYS,
  OWNER_SESSION_PREFIX,
  OWNER_TOKEN_PREFIX,
  type OwnerCredentialSummary
} from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The owner's credentials: tokens for the CLI and sessions for enrolled browsers
 *. Only `sha256(secret)` is stored; the secret is returned once.
 * Nothing here logs a secret or a hash, and a listing carries neither.
 */

export type OwnerCredentialKind = "token" | "browser";

export class OwnerCredentialError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string
  ) {
    super(message);
  }
}

/** A stored credential as the check reads it. */
export interface StoredOwnerCredential {
  id: string;
  kind: OwnerCredentialKind;
  secretHash: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

interface Row {
  id: string;
  kind: OwnerCredentialKind;
  label: string;
  secret_hash: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, kind, label, secret_hash, created_at, last_used_at, expires_at, revoked_at`;
/** At most this many live browsers, so a loop of enrolments cannot fill the table. */
export const MAX_LIVE_BROWSERS = 20;

export const hashOwnerSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export const generateOwnerSecret = (kind: OwnerCredentialKind): string =>
  `${kind === "token" ? OWNER_TOKEN_PREFIX : OWNER_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;

export const sessionExpiry = (from: Date): Date => new Date(from.getTime() + OWNER_SESSION_DAYS * 86_400_000);

const summary = (row: Row): OwnerCredentialSummary => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null
});

/** Makes a credential. A browser session expires 30 days out; an owner token never does. */
export async function createOwnerCredential(
  sql: PoolSql,
  kind: OwnerCredentialKind,
  label: string,
  now: Date = new Date()
): Promise<{ secret: string; summary: OwnerCredentialSummary }> {
  const userId = await ensureUser(sql);
  if (kind === "browser") {
    const live = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM owner_credentials
      WHERE user_id=${userId} AND kind='browser' AND revoked_at IS NULL AND expires_at > ${now}`;
    if ((live[0]?.count ?? 0) >= MAX_LIVE_BROWSERS)
      throw new OwnerCredentialError(409, `${MAX_LIVE_BROWSERS} browsers are already enrolled; revoke one first.`);
  }
  const secret = generateOwnerSecret(kind);
  const rows = await sql<Row[]>`
    INSERT INTO owner_credentials (user_id, kind, label, secret_hash, created_at, expires_at)
    VALUES (${userId}, ${kind}, ${label}, ${hashOwnerSecret(secret)}, ${now}, ${kind === "browser" ? sessionExpiry(now) : null})
    RETURNING ${sql.unsafe(COLUMNS)}`;
  return { secret, summary: summary(rows[0]!) };
}

/** Every credential, newest first, revoked ones included. */
export async function listOwnerCredentials(sql: PoolSql): Promise<OwnerCredentialSummary[]> {
  const userId = await ensureUser(sql);
  const rows = await sql<Row[]>`
    SELECT ${sql.unsafe(COLUMNS)} FROM owner_credentials WHERE user_id=${userId} ORDER BY created_at DESC, id DESC`;
  return rows.map(summary);
}

/** Revokes a live credential at once; idempotent, and a 404 for an id that does not exist. */
export async function revokeOwnerCredential(
  sql: PoolSql,
  id: string,
  now: Date = new Date()
): Promise<OwnerCredentialSummary> {
  const userId = await ensureUser(sql);
  const rows = await sql<Row[]>`
    UPDATE owner_credentials SET revoked_at=${now} WHERE id=${id} AND user_id=${userId} AND revoked_at IS NULL
    RETURNING ${sql.unsafe(COLUMNS)}`;
  if (rows[0]) return summary(rows[0]);
  const existing = await sql<
    Row[]
  >`SELECT ${sql.unsafe(COLUMNS)} FROM owner_credentials WHERE id=${id} AND user_id=${userId}`;
  if (existing[0]) return summary(existing[0]);
  throw new OwnerCredentialError(404, "That credential does not exist.");
}

/** The stored credential for a hash, or null. The caller compares hashes in constant time before trusting it. */
export async function findOwnerCredentialByHash(sql: PoolSql, hash: string): Promise<StoredOwnerCredential | null> {
  const rows = await sql<Row[]>`SELECT ${sql.unsafe(COLUMNS)} FROM owner_credentials WHERE secret_hash=${hash}`;
  const row = rows[0];
  return row
    ? { id: row.id, kind: row.kind, secretHash: row.secret_hash, expiresAt: row.expires_at, revokedAt: row.revoked_at }
    : null;
}

/**
 * Records a use, at most once a minute. A browser session also slides to 30 days from now, but only once it has
 * lost a day, so the cookie is re-sent about daily rather than on every request. Returns true when it slid.
 */
export async function touchOwnerCredential(sql: PoolSql, id: string, kind: OwnerCredentialKind): Promise<boolean> {
  await sql`UPDATE owner_credentials SET last_used_at=now() WHERE id=${id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
  if (kind !== "browser") return false;
  const slid = await sql`
    UPDATE owner_credentials SET expires_at=now() + make_interval(days => ${OWNER_SESSION_DAYS})
    WHERE id=${id} AND revoked_at IS NULL AND expires_at < now() + make_interval(days => ${OWNER_SESSION_DAYS - 1})
    RETURNING id`;
  return slid.length > 0;
}
