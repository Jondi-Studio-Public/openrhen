import { resolveLocale, resolveTimezone } from "@openrhen/contracts";
import { runtimeEnv } from "@/server/runtime-env";
import type { PortalState } from "@/state/portal-state";
import type { Sql, TxSql } from "./sql-pool";
import { seedStartingSubjects, seedStartingSubjectsIfNone } from "./plan-map-store";
import { replaceState } from "./state-replace";

function parseLegacyState(value: unknown): PortalState | null {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as PortalState;
    } catch {
      return null;
    }
  }
  if (value && typeof value === "object" && "projects" in value) return value as PortalState;
  return null;
}

/**
 * Runs `fn` inside a transaction opened on `sql`, unless `sql` is already a transaction (or savepoint)
 * handle — postgres.js transaction handles have no `.begin` (nested transactions are `tx.savepoint`) —
 * in which case `fn` runs directly on `sql` so it joins the caller's already-open transaction instead
 * of throwing.
 *
 * This runtime `"begin" in sql` check is belt-and-braces, not the primary defence: `ensureUser` is
 * deliberately the one function in the portal that must work correctly whichever handle it is given
 * (see `Sql`'s doc comment in sql-pool.ts), so it cannot be typed `PoolSql` the way every other
 * `.begin`-calling function now is. Everywhere else, passing an already-open transaction to a function
 * that opens its own is a `tsc` error before this branch would ever have to catch it at runtime.
 */
function withTransaction<T>(sql: Sql, fn: (tx: TxSql) => Promise<T>): Promise<T> {
  // postgres.js's own `begin` overloads resolve their return type through `UnwrapPromiseArray<T>`,
  // which a caller's generic `T` cannot unify with structurally — the cast is only working around
  // that library typing gap, not re-opening the hole `TxSql` closes: `fn` itself stays fully typed.
  if ("begin" in sql) return sql.begin((transaction) => fn(transaction)) as Promise<T>;
  return fn(sql);
}

/**
 * There is no unique column on `users` to `ON CONFLICT` against — it is deliberately anonymous,
 * single-tenant, no-auth (see the tenancy decision in the system architecture doc) — so the only
 * race-free way to make "the one user" idempotent under concurrent cold starts is to serialize the
 * whole read-or-create with a transaction-scoped advisory lock. `pg_advisory_xact_lock` holds until the
 * transaction ends (commit or rollback), so a second caller blocks here until the first has committed
 * its new row, then reads that same row back instead of racing to insert its own. When `sql` is already
 * a transaction handle (a caller running its own `sql.begin`), the lock attaches to that caller's open
 * transaction instead of opening a nested one.
 */
export async function ensureUser(sql: Sql): Promise<string> {
  // Once the user and its starting subjects exist there is nothing to create, so no lock is needed to read them back.
  // Taking it anyway inside a long transaction (a changeset runs every handler in one) would hold it to the end, and a
  // browser save that holds a row the transaction wants, then reads the user, would deadlock with it.
  const [ready] = await sql<{ id: string; seeded: boolean }[]>`
    SELECT id, EXISTS (SELECT 1 FROM plan_subjects WHERE user_id = users.id) AS seeded
    FROM users ORDER BY created_at LIMIT 1`;
  if (ready?.seeded) return ready.id;
  return withTransaction(sql, async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('ensure-user'))`;

    const existing = await tx<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
    if (existing[0]) {
      // A restore truncates the plan map tables and a pre-13 backup carries none, so the user can exist
      // with no subjects; put the starting set back. A user who has any subject, archived or not, is left alone.
      await seedStartingSubjectsIfNone(tx, existing[0].id);
      return existing[0].id;
    }

    const created = await tx<{ id: string }[]>`
      INSERT INTO users (display_name, timezone, locale)
      VALUES ('Personal planner', ${resolveTimezone(null, runtimeEnv())}, ${resolveLocale(null, runtimeEnv())})
      RETURNING id
    `;
    const userId = created[0]!.id;
    await tx`
      INSERT INTO user_preferences (user_id)
      VALUES (${userId})
      ON CONFLICT (user_id) DO NOTHING
    `;
    await seedStartingSubjects(tx, userId);

    const legacyRows = await tx<{ state_json: unknown }[]>`SELECT state_json FROM portal_state WHERE id = 1`;
    const legacy = parseLegacyState(legacyRows[0]?.state_json);
    if (legacy) {
      await replaceState(tx, userId, legacy);
      await tx`DELETE FROM portal_state WHERE id = 1`;
    }
    return userId;
  });
}
