import postgres from "postgres";

/**
 * A pooled top-level connection — the only kind of handle that can open a transaction (`.begin`).
 * Every function that opens its own transaction (`sql.begin(...)`) should take `PoolSql`, not `Sql`,
 * so passing it an already-open transaction handle is a `tsc` error rather than the
 * `TypeError: sql.begin is not a function` a nested `NormalizedPostgresStateStore.put()` call once
 * threw (fixed at runtime in ensure-user.ts's `withTransaction`; see that file's comment for why the
 * type system is now the primary defence and the runtime check is only belt-and-braces).
 */
export type PoolSql = postgres.Sql;

/**
 * A handle already inside an open transaction, or savepoint — postgres.js's own `TransactionSql`. It
 * genuinely has no `.begin` (a nested transaction is `tx.savepoint`), so a function typed to take
 * `TxSql` cannot call `sql.begin(...)` without `tsc` refusing it — no cast required at the call site
 * to satisfy it, since the callback parameter of `PoolSql["begin"]` is already a `TransactionSql`.
 * Use this for a function that only ever runs inside a caller's already-open transaction.
 */
export type TxSql = postgres.TransactionSql;

/**
 * Either kind. Because `PoolSql` and `TxSql` only share the members `ISql` gives both of them, a
 * `Sql`-typed value cannot call `.begin` at all without narrowing first — exactly what `ensureUser`
 * does. Reach for this only for a function like `ensureUser`/`readPortalState` that must run
 * correctly whichever handle it is given and never opens a transaction of its own; everything else
 * should be `PoolSql` (opens one) or `TxSql` (only ever runs inside one already open).
 */
export type Sql = PoolSql | TxSql;

/**
 * One connection pool per database URL, created on first use and reused for the life of the process.
 *
 * Every store used to open a client per operation and `end()` it in a `finally`. That was right on
 * the Workers runtime, where an isolate could not keep sockets between requests, but under Node it
 * charges a TCP and TLS handshake to every request the portal serves. Keying by connection string
 * means the integration suites, which point at the `_test` databases, get their own pool rather than
 * sharing one with whatever the process opened first.
 */
const pools = new Map<string, PoolSql>();

export function sqlPool(connectionString: string): PoolSql {
  const existing = pools.get(connectionString);
  if (existing) return existing;
  // `postgres()` connects lazily, so building the pool here costs nothing until the first query.
  // Idle connections are released after half a minute and recycled after half an hour, so a portal
  // left open overnight neither pins server-side sessions nor keeps a socket a restarted database
  // or proxy has already forgotten.
  const pool = postgres(connectionString, {
    max: 5,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    // Needed to serialize a JS array into a real Postgres array literal for `= ANY(${ids})` (used by
    // the deliverable source store): without it postgres.js can't resolve the element type's OID and
    // falls back to a bare comma-joined string with no braces, which the server rejects as a
    // malformed array literal — found by exercising this path live, see the cli deliverables design note.
    fetch_types: true,
    prepare: true,
    connect_timeout: 10,
    connection: { application_name: "OpenRhen local portal" }
  });
  pools.set(connectionString, pool);
  return pool;
}
