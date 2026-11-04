import type { PoolSql, TxSql } from "./sql-pool";

/**
 * A transaction handle that the command handlers can take as their pool: each one opens its own transaction with
 * `sql.begin`, which here becomes a savepoint inside the changeset's one transaction. Everything else is the
 * transaction itself.
 */
export function nestedPool(tx: TxSql): PoolSql {
  type Body = (sp: TxSql) => unknown;
  // `begin(fn)` or `begin(options, fn)`; a savepoint takes no options.
  const begin = (first: unknown, second?: unknown) =>
    tx.savepoint((typeof first === "function" ? first : second) as Body);
  return new Proxy(tx, {
    get: (target, property, receiver) => (property === "begin" ? begin : Reflect.get(target, property, receiver)),
    has: (target, property) => property === "begin" || Reflect.has(target, property),
    apply: (target, thisArg, args) => Reflect.apply(target as never, thisArg, args)
  }) as unknown as PoolSql;
}
