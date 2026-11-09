import { lockActivityUser } from "./activity-lock";
import type { PoolSql, Sql, TxSql } from "./sql-pool";

/**
 * Per-extractor-version state for the derived-rows runner (communication understanding, slice 2a-2c): where its scans
 * have reached (`cursor`), when it last finished a run cleanly, its last error, and which version is the active one.
 *
 * `active` is a promotion record, not a user setting: the first version of an extractor becomes active when it is
 * created, and `promoteExtractorVersion` makes a later one active after the comparison work shows it is better. Reads
 * of `derived` rows show the active version only. Nothing here turns the runner off.
 *
 * Every promotion, including the first, is also written into the promoted version's `cursor.promotions` as
 * `{version, at}`, because `as_of` reads need to know which version was active at an earlier time and the table has no
 * column for it. The runner's cursor writes merge into the cursor and never touch `promotions`.
 */

export interface ExtractorStateRow {
  extractor: string;
  version: string;
  active: boolean;
  cursor: Record<string, unknown>;
  lastOkAt: Date | null;
  lastError: string | null;
}

interface StateRow {
  extractor: string;
  version: string;
  active: boolean;
  cursor: Record<string, unknown> | null;
  last_ok_at: Date | null;
  last_error: string | null;
}

const toState = (row: StateRow): ExtractorStateRow => ({
  extractor: row.extractor,
  version: row.version,
  active: row.active,
  cursor: row.cursor ?? {},
  lastOkAt: row.last_ok_at,
  lastError: row.last_error
});

/**
 * The state row of this extractor version, created if it has none. A new row is active when no version of the
 * extractor is held yet, and inactive otherwise (a later version waits for `promoteExtractorVersion`). Run it under
 * the activity lock (the runner does) so two first runs cannot both decide they are first.
 */
export async function ensureExtractorStateTx(
  tx: TxSql,
  userId: string,
  extractor: string,
  version: string,
  now: Date
): Promise<ExtractorStateRow> {
  const [held] = await tx<StateRow[]>`
    SELECT extractor, version, active, cursor, last_ok_at, last_error FROM extractor_state
    WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}`;
  if (held) return toState(held);
  const [others] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM extractor_state WHERE user_id = ${userId} AND extractor = ${extractor}`;
  const active = (others?.n ?? 0) === 0;
  const cursor = active ? { promotions: [{ version, at: now.toISOString() }] } : {};
  const [created] = await tx<StateRow[]>`
    INSERT INTO extractor_state (user_id, extractor, version, cursor, active)
    VALUES (${userId}, ${extractor}, ${version}, ${tx.json(cursor as never)}, ${active})
    RETURNING extractor, version, active, cursor, last_ok_at, last_error`;
  return toState(created!);
}

export interface ExtractorProgress {
  /** Merged into the cursor key by key; keys left out keep their value, and `promotions` is not touched. */
  cursor: Record<string, unknown>;
  lastOkAt?: Date | undefined;
  /** `null` clears the error; leave out to keep it. */
  lastError?: string | null | undefined;
}

export async function saveExtractorProgressTx(
  tx: TxSql,
  userId: string,
  extractor: string,
  version: string,
  progress: ExtractorProgress
): Promise<void> {
  const { promotions: _ignored, ...patch } = progress.cursor;
  await tx`
    UPDATE extractor_state SET
      cursor = COALESCE(cursor, '{}'::jsonb) || ${tx.json(patch as never)}::jsonb,
      last_ok_at = ${progress.lastOkAt === undefined ? tx`last_ok_at` : progress.lastOkAt},
      last_error = ${progress.lastError === undefined ? tx`last_error` : progress.lastError}
    WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}`;
}

/**
 * Makes `version` the active one for `extractor`, atomically (the partial unique index allows one active version per
 * person and extractor, so the old one is cleared first, inside the same transaction), and records `promotedAt` in the
 * promoted version's cursor. A version with no row yet gets one. Already active is a no-op and records nothing. No UI
 * and no route: a promotion is a deliberate act by whoever has compared the versions. It also changes what Mark sees:
 * the open-facts read (`readOpenFacts`, behind the attention feed's `fact_open` items) takes fact rows of the active
 * version only, so facts the old version wrote stop being listed at once and the new version's appear as it extracts.
 * Read `?report=eval` for both versions and record the numbers before promoting.
 */
export async function promoteExtractorVersion(
  sql: PoolSql,
  userId: string,
  extractor: string,
  version: string,
  promotedAt: Date
): Promise<{ promoted: boolean }> {
  if (extractor.trim() === "") throw new Error("extractor must name the extractor to promote, such as msg-class-t0.");
  if (version.trim() === "") throw new Error('version must name the version to promote, such as "2".');
  return sql.begin(async (tx) => {
    // The runner holds this lock for the length of a run, so a promotion lands between runs, never in the middle of one.
    await lockActivityUser(tx, userId);
    const [target] = await tx<{ active: boolean }[]>`
      SELECT active FROM extractor_state
      WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}`;
    if (target?.active) return { promoted: false };
    if (!target)
      await tx`INSERT INTO extractor_state (user_id, extractor, version, cursor, active)
        VALUES (${userId}, ${extractor}, ${version}, '{}'::jsonb, false)`;
    await tx`UPDATE extractor_state SET active = false WHERE user_id = ${userId} AND extractor = ${extractor} AND active`;
    const entry = { version, at: promotedAt.toISOString() };
    await tx`
      UPDATE extractor_state SET
        active = true,
        cursor = jsonb_set(
          COALESCE(cursor, '{}'::jsonb),
          '{promotions}',
          COALESCE(cursor -> 'promotions', '[]'::jsonb) || ${tx.json(entry as never)}::jsonb
        )
      WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}`;
    return { promoted: true };
  });
}

/** Every extractor version the person holds, for the summary route. */
export async function readExtractorStates(sql: Sql, userId: string): Promise<ExtractorStateRow[]> {
  const rows = await sql<StateRow[]>`
    SELECT extractor, version, active, cursor, last_ok_at, last_error FROM extractor_state
    WHERE user_id = ${userId} ORDER BY extractor, version`;
  return rows.map(toState);
}

/** The cursor of one extractor version, or null when it has no state row. Run it under the activity lock to see what a run just wrote. */
export async function readExtractorCursorTx(
  tx: TxSql,
  userId: string,
  extractor: string,
  version: string
): Promise<Record<string, unknown> | null> {
  const [row] = await tx<{ cursor: Record<string, unknown> | null }[]>`
    SELECT cursor FROM extractor_state
    WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}`;
  return row ? (row.cursor ?? {}) : null;
}

/** As `readExtractorCursorTx`, with whether the version is the active one right now. */
export async function readExtractorStateTx(
  tx: TxSql,
  userId: string,
  extractor: string,
  version: string
): Promise<{ cursor: Record<string, unknown>; active: boolean } | null> {
  const [row] = await tx<{ cursor: Record<string, unknown> | null; active: boolean }[]>`
    SELECT cursor, active FROM extractor_state
    WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}`;
  return row ? { cursor: row.cursor ?? {}, active: row.active } : null;
}

/**
 * Pushes the lease expiry of a run that still holds it. A single statement, no lock: only the holder of the token
 * matches, so a run whose lease was taken over (or released) renews nothing and gets false.
 */
export async function renewExtractorLease(
  sql: Sql,
  userId: string,
  extractor: string,
  version: string,
  token: string,
  expiresAt: Date
): Promise<boolean> {
  const rows = await sql`
    UPDATE extractor_state
    SET cursor = jsonb_set(cursor, '{lease,expiresAt}', to_jsonb(${expiresAt.toISOString()}::text))
    WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${version}
      AND cursor -> 'lease' ->> 'token' = ${token}
    RETURNING 1`;
  return rows.length > 0;
}

/** The models a version runs with, as the model tick pins them in `cursor.models`. */
export interface ModelPins {
  t2: { id: string; digest: string | null } | null;
  t3: { id: string } | null;
}

export type PinOutcome = { action: "none" | "unchanged" } | { action: "created" | "repinned"; version: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const pinId = (value: unknown): string | null => {
  const record = asRecord(value);
  return record && typeof record.id === "string" ? record.id : null;
};

/**
 * Called when the model settings are saved. A model extractor's versions are counters pinned to the models they were
 * created with (amendment 7), so saving a model id that no version of `extractor` runs with creates the NEXT version,
 * INACTIVE: it shadow-reads the labelled messages and live mail with the new model, and stays out of every read until
 * someone promotes it with `promoteExtractorVersion` after reading `?report=eval`. The active version never changes.
 *
 * - No version of the extractor yet: nothing to do (the first run pins the then-current settings).
 * - A version already pinned to exactly these models (whatever its role): nothing to do.
 * - The newest version is inactive and has not run yet (no forward mark): its pins are replaced in place, so changing
 *   your mind before it ran does not stack up unread versions.
 * - Otherwise the next number (highest + 1) is created inactive, pinned to the new models.
 *
 * Runs under the per-person activity lock so it cannot interleave with a tick's batch read.
 */
export async function pinModelVersionTx(
  tx: TxSql,
  userId: string,
  extractor: string,
  models: ModelPins
): Promise<PinOutcome> {
  await lockActivityUser(tx, userId);
  const rows = await tx<{ version: string; active: boolean; cursor: Record<string, unknown> | null }[]>`
    SELECT version, active, cursor FROM extractor_state WHERE user_id = ${userId} AND extractor = ${extractor}`;
  const numbered = rows
    .map((row) => ({ ...row, n: /^\d{1,9}$/.test(row.version) ? Number(row.version) : Number.NaN }))
    .filter((row) => Number.isFinite(row.n))
    .sort((a, b) => a.n - b.n);
  if (numbered.length === 0) return { action: "none" };
  const same = (cursor: Record<string, unknown> | null) => {
    const held = asRecord(cursor?.models);
    return held !== null && pinId(held.t2) === (models.t2?.id ?? null) && pinId(held.t3) === (models.t3?.id ?? null);
  };
  if (numbered.some((row) => same(row.cursor))) return { action: "unchanged" };
  const newest = numbered[numbered.length - 1]!;
  const pins = tx.json({ models } as never);
  if (!newest.active && asRecord(newest.cursor)?.forward === undefined) {
    await tx`
      UPDATE extractor_state SET cursor = COALESCE(cursor, '{}'::jsonb) || ${pins}::jsonb
      WHERE user_id = ${userId} AND extractor = ${extractor} AND version = ${newest.version}`;
    return { action: "repinned", version: newest.version };
  }
  const version = String(newest.n + 1);
  await tx`
    INSERT INTO extractor_state (user_id, extractor, version, cursor, active)
    VALUES (${userId}, ${extractor}, ${version}, ${pins}, false)`;
  return { action: "created", version };
}
