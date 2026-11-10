import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  DEVICE_CODE_INTERVAL_SECONDS,
  DEVICE_PAIRING_MINUTES,
  OWNER_SESSION_DAYS,
  OWNER_SESSION_PREFIX,
  OWNER_TOKEN_PREFIX,
  type DeviceCodeError,
  type DeviceIdentity,
  type OwnerCredentialEvent,
  type OwnerCredentialSummary
} from "@openrhen/contracts";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import type { PoolSql, TxSql } from "@/server/persistence/postgres/sql-pool";

/**
 * The owner's credentials: tokens for the CLI and sessions for enrolled browsers
 *. Only `sha256(secret)` is stored; the secret is returned once.
 * Nothing here logs a secret or a hash, and a listing carries neither.
 */

export type OwnerCredentialKind = "token" | "browser";

export class OwnerCredentialError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
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
  /** A limited credential is refused the `owner-admin` routes. */
  limited: boolean;
  /** Set on a credential made by device sign-in. */
  device: DeviceIdentity | null;
  /** A web-view session's device credential. */
  parentId: string | null;
}

interface Row {
  id: string;
  user_id: string;
  kind: OwnerCredentialKind;
  label: string;
  secret_hash: string;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  device_install_id: string | null;
  platform: string | null;
  limited: boolean;
  parent_credential_id: string | null;
  last_used_from: string | null;
}

const COLUMNS = `id, user_id, kind, label, secret_hash, created_at, last_used_at, expires_at, revoked_at,
  device_install_id, platform, limited, parent_credential_id, last_used_from`;
/** At most this many live browsers, so a loop of enrolments cannot fill the table. */
export const MAX_LIVE_BROWSERS = 20;

export const hashOwnerSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

export const generateOwnerSecret = (kind: OwnerCredentialKind): string =>
  `${kind === "token" ? OWNER_TOKEN_PREFIX : OWNER_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;

export const sessionExpiry = (from: Date): Date => new Date(from.getTime() + OWNER_SESSION_DAYS * 86_400_000);

const deviceOf = (row: Row): DeviceIdentity | null =>
  row.device_install_id ? { installId: row.device_install_id, platform: row.platform ?? "other" } : null;

const summary = (row: Row): OwnerCredentialSummary => ({
  id: row.id,
  kind: row.kind,
  label: row.label,
  createdAt: row.created_at.toISOString(),
  lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
  expiresAt: row.expires_at ? row.expires_at.toISOString() : null,
  revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  device: deviceOf(row),
  limited: row.limited,
  parentCredentialId: row.parent_credential_id,
  lastUsedFrom: row.last_used_from
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
      WHERE user_id=${userId} AND kind='browser' AND parent_credential_id IS NULL AND revoked_at IS NULL AND expires_at > ${now}`;
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

/** Who did a revoke, for the record on the Devices page. */
export interface CredentialActor {
  actorId?: string | null;
  address?: string | null;
}

type EventName = OwnerCredentialEvent["event"];

interface EventInput extends CredentialActor {
  event: EventName;
  credentialId?: string | null;
  label?: string | null;
  device?: DeviceIdentity | null;
}

/** Events older than this are dropped when a new one is written, so the table cannot grow without bound. */
const EVENT_KEEP_DAYS = 365;

async function recordEvent(tx: TxSql, userId: string, input: EventInput, now: Date): Promise<void> {
  await tx`
    INSERT INTO owner_credential_events
      (user_id, occurred_at, event, credential_id, actor_credential_id, label, device_install_id, platform, address)
    VALUES (${userId}, ${now}, ${input.event}, ${input.credentialId ?? null}, ${input.actorId ?? null},
      ${input.label ?? null}, ${input.device?.installId ?? null}, ${input.device?.platform ?? null},
      ${input.address ?? null})`;
  await tx`DELETE FROM owner_credential_events WHERE user_id=${userId} AND occurred_at < ${new Date(now.getTime() - EVENT_KEEP_DAYS * 86_400_000)}`;
}

/** Revokes the live credentials among `ids` and their live children, recording each. Returns the rows it revoked. */
async function revokeTree(tx: TxSql, userId: string, id: string, now: Date, actor: CredentialActor): Promise<Row[]> {
  const rows = await tx<Row[]>`
    UPDATE owner_credentials SET revoked_at=${now}
    WHERE user_id=${userId} AND revoked_at IS NULL AND (id=${id} OR parent_credential_id=${id})
    RETURNING ${tx.unsafe(COLUMNS)}`;
  for (const row of rows)
    await recordEvent(
      tx,
      userId,
      { event: "revoked", credentialId: row.id, label: row.label, device: deviceOf(row), ...actor },
      now
    );
  return rows;
}

/**
 * Revokes a live credential at once, and the web-view sessions that descend from it; idempotent, and a 404 for an id
 * that does not exist. Each credential it ends is recorded.
 */
export async function revokeOwnerCredential(
  sql: PoolSql,
  id: string,
  now: Date = new Date(),
  actor: CredentialActor = {}
): Promise<OwnerCredentialSummary> {
  const userId = await ensureUser(sql);
  const revoked = await sql.begin((tx) => revokeTree(tx, userId, id, now, actor));
  const own = revoked.find((row) => row.id === id);
  if (own) return summary(own);
  const existing = await sql<
    Row[]
  >`SELECT ${sql.unsafe(COLUMNS)} FROM owner_credentials WHERE id=${id} AND user_id=${userId}`;
  if (existing[0]) return summary(existing[0]);
  throw new OwnerCredentialError(404, "That credential does not exist.");
}

/** One credential's summary, or null. */
export async function getOwnerCredential(sql: PoolSql, id: string): Promise<OwnerCredentialSummary | null> {
  const userId = await ensureUser(sql);
  const rows = await sql<
    Row[]
  >`SELECT ${sql.unsafe(COLUMNS)} FROM owner_credentials WHERE id=${id} AND user_id=${userId}`;
  return rows[0] ? summary(rows[0]) : null;
}

/** The stored credential for a hash, or null. The caller compares hashes in constant time before trusting it. */
export async function findOwnerCredentialByHash(sql: PoolSql, hash: string): Promise<StoredOwnerCredential | null> {
  const rows = await sql<Row[]>`SELECT ${sql.unsafe(COLUMNS)} FROM owner_credentials WHERE secret_hash=${hash}`;
  const row = rows[0];
  return row
    ? {
        id: row.id,
        kind: row.kind,
        secretHash: row.secret_hash,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        limited: row.limited,
        device: deviceOf(row),
        parentId: row.parent_credential_id
      }
    : null;
}

/**
 * Records a use, at most once a minute, with the address it came from. A browser session also slides to 30 days from
 * now, but only once it has lost a day, so the cookie is re-sent about daily rather than on every request. Returns
 * true when it slid.
 */
export async function touchOwnerCredential(
  sql: PoolSql,
  id: string,
  kind: OwnerCredentialKind,
  address: string | null = null
): Promise<boolean> {
  await sql`UPDATE owner_credentials SET last_used_at=now(), last_used_from=${address} WHERE id=${id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
  if (kind !== "browser") return false;
  const slid = await sql`
    UPDATE owner_credentials SET expires_at=now() + make_interval(days => ${OWNER_SESSION_DAYS})
    WHERE id=${id} AND revoked_at IS NULL AND expires_at < now() + make_interval(days => ${OWNER_SESSION_DAYS - 1})
    RETURNING id`;
  return slid.length > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Device sign-in: a phone gets its own revocable owner token by QR pairing or by a typed code.
// ---------------------------------------------------------------------------------------------------------------

const PAIRING_MS = DEVICE_PAIRING_MINUTES * 60_000;
/** At most this many unexpired pairings or codes at once, so a loop of requests cannot fill the table. */
export const MAX_LIVE_PAIRINGS = 10;
/** The typed code's alphabet: consonants only (RFC 8628's advice), so a code never spells a word or looks like a digit. */
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

const newPairingSecret = (): string => `pri_pair_${randomBytes(32).toString("base64url")}`;
const newDeviceCode = (): string => `pri_dcode_${randomBytes(32).toString("base64url")}`;

/** Eight letters, shown as `BCDF-GHJK`. */
export function newUserCode(): string {
  let code = "";
  for (let i = 0; i < 8; i += 1) code += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** What a person typed, reduced to the letters it can hold; null when it cannot be a code. */
export function normaliseUserCode(typed: string): string | null {
  const letters = typed.toUpperCase().replace(/[\s-]/g, "");
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(letters) ? letters : null;
}

const userCodeHash = (letters: string) => hashOwnerSecret(`user-code:${letters}`);

interface PairingRow {
  id: string;
  user_id: string;
  flow: "pairing" | "code";
  status: "pending" | "approved" | "denied" | "redeemed";
  name: string | null;
  install_id: string | null;
  platform: string | null;
  expires_at: Date;
  poll_interval_seconds: number;
  last_polled_at: Date | null;
  created_from: string | null;
  created_at: Date;
}

const PAIRING_COLUMNS = `id, user_id, flow, status, name, install_id, platform, expires_at, poll_interval_seconds,
  last_polled_at, created_from, created_at`;

async function pruneAndCheckRoom(tx: TxSql, userId: string, flow: "pairing" | "code", now: Date): Promise<void> {
  await tx`DELETE FROM owner_device_pairings WHERE user_id=${userId} AND expires_at < ${new Date(now.getTime() - 86_400_000)}`;
  const live = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM owner_device_pairings
    WHERE user_id=${userId} AND flow=${flow} AND status IN ('pending','approved') AND expires_at > ${now}`;
  if ((live[0]?.count ?? 0) >= MAX_LIVE_PAIRINGS)
    throw new OwnerCredentialError(429, "Too many pairings are waiting; wait ten minutes or use one of them.");
}

/** The owner starts a QR pairing. The secret is returned once; it works once, within ten minutes. */
export async function startDevicePairing(
  sql: PoolSql,
  actor: CredentialActor,
  now: Date = new Date()
): Promise<{ id: string; secret: string; expiresAt: Date }> {
  const userId = await ensureUser(sql);
  return sql.begin(async (tx) => {
    await pruneAndCheckRoom(tx, userId, "pairing", now);
    const secret = newPairingSecret();
    const expiresAt = new Date(now.getTime() + PAIRING_MS);
    const rows = await tx<{ id: string }[]>`
      INSERT INTO owner_device_pairings
        (user_id, flow, status, secret_hash, created_at, expires_at, created_by_credential_id, created_from)
      VALUES (${userId}, 'pairing', 'approved', ${hashOwnerSecret(secret)}, ${now}, ${expiresAt},
        ${actor.actorId ?? null}, ${actor.address ?? null})
      RETURNING id`;
    await recordEvent(tx, userId, { event: "pairing_started", ...actor }, now);
    return { id: rows[0]!.id, secret, expiresAt };
  });
}

/** Makes the limited owner token for a device, replacing any live token the same install already holds. */
async function mintDeviceCredential(
  tx: TxSql,
  userId: string,
  device: DeviceIdentity,
  label: string,
  address: string | null,
  now: Date
): Promise<{ secret: string; summary: OwnerCredentialSummary }> {
  const older = await tx<{ id: string }[]>`
    SELECT id FROM owner_credentials
    WHERE user_id=${userId} AND kind='token' AND device_install_id=${device.installId} AND revoked_at IS NULL`;
  for (const row of older) await revokeTree(tx, userId, row.id, now, { address });
  const secret = generateOwnerSecret("token");
  const rows = await tx<Row[]>`
    INSERT INTO owner_credentials
      (user_id, kind, label, secret_hash, created_at, device_install_id, platform, limited, last_used_from)
    VALUES (${userId}, 'token', ${label}, ${hashOwnerSecret(secret)}, ${now}, ${device.installId}, ${device.platform},
      true, ${address})
    RETURNING ${tx.unsafe(COLUMNS)}`;
  const row = rows[0]!;
  await recordEvent(tx, userId, { event: "redeemed", credentialId: row.id, label, device, address }, now);
  return { secret, summary: summary(row) };
}

/**
 * The device redeems the secret from a QR. Atomic: the pairing flips to redeemed only if it was approved and
 * unexpired, so a second use, an expired or an unknown secret all get `null`.
 */
export async function redeemDevicePairing(
  sql: PoolSql,
  input: { secret: string; name: string; device: DeviceIdentity; address: string | null },
  now: Date = new Date()
): Promise<{ secret: string; summary: OwnerCredentialSummary } | null> {
  return sql.begin(async (tx) => {
    const claimed = await tx<{ id: string; user_id: string }[]>`
      UPDATE owner_device_pairings
      SET status='redeemed', redeemed_at=${now}, name=${input.name}, install_id=${input.device.installId},
          platform=${input.device.platform}
      WHERE secret_hash=${hashOwnerSecret(input.secret)} AND flow='pairing' AND status='approved' AND expires_at > ${now}
      RETURNING id, user_id`;
    const pairing = claimed[0];
    if (!pairing) return null;
    const minted = await mintDeviceCredential(tx, pairing.user_id, input.device, input.name, input.address, now);
    await tx`UPDATE owner_device_pairings SET credential_id=${minted.summary.id} WHERE id=${pairing.id}`;
    return minted;
  });
}

/** A device with no signed-in screen asks for a code. The device code and the typed code are each returned once. */
export async function startDeviceCode(
  sql: PoolSql,
  input: { name: string; device: DeviceIdentity; address: string | null },
  now: Date = new Date()
): Promise<{ deviceCode: string; userCode: string; expiresAt: Date; interval: number }> {
  const userId = await ensureUser(sql);
  return sql.begin(async (tx) => {
    await pruneAndCheckRoom(tx, userId, "code", now);
    const deviceCode = newDeviceCode();
    const expiresAt = new Date(now.getTime() + PAIRING_MS);
    for (let attempt = 0; ; attempt += 1) {
      const userCode = newUserCode();
      const letters = normaliseUserCode(userCode)!;
      try {
        await tx.savepoint(async (inner) => {
          await inner`
            INSERT INTO owner_device_pairings
              (user_id, flow, status, secret_hash, user_code_hash, name, install_id, platform, created_at, expires_at,
               created_from)
            VALUES (${userId}, 'code', 'pending', ${hashOwnerSecret(deviceCode)}, ${userCodeHash(letters)}, ${input.name},
              ${input.device.installId}, ${input.device.platform}, ${now}, ${expiresAt}, ${input.address})`;
        });
      } catch (error) {
        // Two live codes with the same letters (one in 25 billion): draw again.
        if (attempt < 4 && (error as { code?: string }).code === "23505") continue;
        throw error;
      }
      await recordEvent(
        tx,
        userId,
        { event: "code_started", label: input.name, device: input.device, address: input.address },
        now
      );
      return { deviceCode, userCode, expiresAt, interval: DEVICE_CODE_INTERVAL_SECONDS };
    }
  });
}

export interface PendingDeviceCode {
  name: string;
  device: DeviceIdentity;
  requestedAt: string;
  from: string | null;
}

const pendingOf = (row: PairingRow): PendingDeviceCode => ({
  name: row.name ?? "A device",
  device: { installId: row.install_id ?? "", platform: row.platform ?? "other" },
  requestedAt: row.created_at.toISOString(),
  from: row.created_from
});

/** The device waiting behind a typed code, for the approval page to show; null for an unknown, used or expired code. */
export async function lookupDeviceCode(
  sql: PoolSql,
  typed: string,
  now: Date = new Date()
): Promise<PendingDeviceCode | null> {
  const letters = normaliseUserCode(typed);
  if (!letters) return null;
  const rows = await sql<PairingRow[]>`
    SELECT ${sql.unsafe(PAIRING_COLUMNS)} FROM owner_device_pairings
    WHERE user_code_hash=${userCodeHash(letters)} AND status='pending' AND expires_at > ${now}`;
  return rows[0] ? pendingOf(rows[0]) : null;
}

/** The owner approves or denies the device behind a typed code. Null when the code is unknown, used or expired. */
export async function decideDeviceCode(
  sql: PoolSql,
  typed: string,
  decision: "approve" | "deny",
  actor: CredentialActor,
  now: Date = new Date()
): Promise<PendingDeviceCode | null> {
  const letters = normaliseUserCode(typed);
  if (!letters) return null;
  return sql.begin(async (tx) => {
    const rows = await tx<PairingRow[]>`
      UPDATE owner_device_pairings
      SET status=${decision === "approve" ? "approved" : "denied"}, decided_at=${now}
      WHERE user_code_hash=${userCodeHash(letters)} AND status='pending' AND expires_at > ${now}
      RETURNING ${tx.unsafe(PAIRING_COLUMNS)}`;
    const row = rows[0];
    if (!row) return null;
    await recordEvent(
      tx,
      row.user_id,
      {
        event: decision === "approve" ? "code_approved" : "code_denied",
        label: row.name,
        device: row.install_id ? { installId: row.install_id, platform: row.platform ?? "other" } : null,
        ...actor
      },
      now
    );
    return pendingOf(row);
  });
}

export type DeviceCodePoll =
  { kind: "error"; error: DeviceCodeError } | { kind: "token"; secret: string; summary: OwnerCredentialSummary };

/**
 * The device polls with its device code (RFC 8628's shape). Polling faster than the interval answers `slow_down` and
 * widens the interval by five seconds. An approved code mints the token on this call, once; after that the code is
 * spent. An unknown code answers `expired_token`, like an expired or spent one.
 */
export async function pollDeviceCode(
  sql: PoolSql,
  deviceCode: string,
  address: string | null,
  now: Date = new Date()
): Promise<DeviceCodePoll> {
  return sql.begin(async (tx): Promise<DeviceCodePoll> => {
    const rows = await tx<PairingRow[]>`
      SELECT ${tx.unsafe(PAIRING_COLUMNS)} FROM owner_device_pairings
      WHERE secret_hash=${hashOwnerSecret(deviceCode)} AND flow='code' FOR UPDATE`;
    const row = rows[0];
    if (!row || row.status === "redeemed" || row.expires_at.getTime() <= now.getTime())
      return { kind: "error", error: "expired_token" };
    if (row.status === "denied") return { kind: "error", error: "access_denied" };
    const sinceLast = row.last_polled_at ? now.getTime() - row.last_polled_at.getTime() : Infinity;
    if (sinceLast < row.poll_interval_seconds * 1000) {
      await tx`UPDATE owner_device_pairings SET last_polled_at=${now}, poll_interval_seconds=poll_interval_seconds + 5 WHERE id=${row.id}`;
      return { kind: "error", error: "slow_down" };
    }
    await tx`UPDATE owner_device_pairings SET last_polled_at=${now} WHERE id=${row.id}`;
    if (row.status === "pending") return { kind: "error", error: "authorization_pending" };
    const device = { installId: row.install_id ?? "", platform: row.platform ?? "other" };
    const minted = await mintDeviceCredential(tx, row.user_id, device, row.name ?? "A device", address, now);
    await tx`UPDATE owner_device_pairings SET status='redeemed', redeemed_at=${now}, credential_id=${minted.summary.id} WHERE id=${row.id}`;
    return { kind: "token", secret: minted.secret, summary: minted.summary };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Web-view session
// ---------------------------------------------------------------------------------------------------------------

/**
 * The cookie secret for a device's web view: a browser-kind child of the device credential. It inherits `limited`,
 * is revoked with the device, and does not count toward the browser cap. One live child per device: a later launch
 * rotates that child's secret in place (a fresh 30 days) rather than adding a row, so the previous cookie stops
 * working once the new one is set. Null when the parent is not a live token.
 */
export async function openWebSession(
  sql: PoolSql,
  parentId: string,
  now: Date = new Date()
): Promise<{ secret: string; summary: OwnerCredentialSummary } | null> {
  return sql.begin(async (tx) => {
    const parents = await tx<Row[]>`
      SELECT ${tx.unsafe(COLUMNS)} FROM owner_credentials
      WHERE id=${parentId} AND kind='token' AND revoked_at IS NULL FOR UPDATE`;
    const parent = parents[0];
    if (!parent) return null;
    const secret = generateOwnerSecret("browser");
    const expiresAt = sessionExpiry(now);
    const label = `${parent.label.slice(0, 48)} (web view)`;
    const existing = await tx<Row[]>`
      UPDATE owner_credentials
      SET secret_hash=${hashOwnerSecret(secret)}, expires_at=${expiresAt}, limited=${parent.limited}, label=${label}
      WHERE parent_credential_id=${parentId} AND revoked_at IS NULL
      RETURNING ${tx.unsafe(COLUMNS)}`;
    if (existing[0]) return { secret, summary: summary(existing[0]) };
    const rows = await tx<Row[]>`
      INSERT INTO owner_credentials
        (user_id, kind, label, secret_hash, created_at, expires_at, device_install_id, platform, limited,
         parent_credential_id)
      VALUES (${parent.user_id}, 'browser', ${label}, ${hashOwnerSecret(secret)}, ${now}, ${expiresAt},
        ${parent.device_install_id}, ${parent.platform}, ${parent.limited}, ${parentId})
      RETURNING ${tx.unsafe(COLUMNS)}`;
    return { secret, summary: summary(rows[0]!) };
  });
}

/** The newest events first, for the Devices page. */
export async function listCredentialEvents(sql: PoolSql, limit = 50): Promise<OwnerCredentialEvent[]> {
  const userId = await ensureUser(sql);
  const rows = await sql<
    {
      id: string;
      occurred_at: Date;
      event: OwnerCredentialEvent["event"];
      label: string | null;
      device_install_id: string | null;
      platform: string | null;
      address: string | null;
    }[]
  >`
    SELECT id, occurred_at, event, label, device_install_id, platform, address FROM owner_credential_events
    WHERE user_id=${userId} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`;
  return rows.map((row) => ({
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    event: row.event,
    label: row.label,
    device: row.device_install_id ? { installId: row.device_install_id, platform: row.platform ?? "other" } : null,
    address: row.address
  }));
}
