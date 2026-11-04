import type { Column, Table } from "drizzle-orm";

/**
 * What postgres.js hands back for one column, which is not always what Drizzle's own driver would.
 * Every `date` and `timestamp` type is parsed to a `Date` whatever mode the schema declares (`date`
 * mode `string` included), and `numeric` and `bigint` arrive as strings. `db-row.integration.test.ts`
 * reads a row of each kind back through the real pool to keep this mapping honest.
 * `schema-matches-database.integration.test.ts` checks that `schema.ts` itself matches the migrated
 * database, but a column an `&` intersection narrows by hand (a `text` to a union, a `jsonb` to a shape, a nullable
 * column a `WHERE` rules out) is a claim about the data that no check covers.
 */
type Decoded<C extends Column> = C["_"]["columnType"] extends
  "PgDate" | "PgDateString" | "PgTimestamp" | "PgTimestampString"
  ? Date
  : C["_"]["columnType"] extends
        | "PgNumeric"
        | "PgNumericNumber"
        | "PgNumericBigInt"
        | "PgBigInt53"
        | "PgBigInt64"
        | "PgBigSerial53"
        | "PgBigSerial64"
    ? string
    : C["_"]["data"];

type Value<C extends Column> = C["_"]["notNull"] extends true ? Decoded<C> : Decoded<C> | null;

type Columns<T extends Table> = T["_"]["columns"];

/**
 * A whole row of `T` as a raw `sql` query returns it: keyed by database column name (`sort_order`, not
 * `sortOrder`) because the pool has no case transform, and typed from `schema.ts`, so renaming a
 * column or making it nullable breaks `tsc` at every read instead of returning `undefined` quietly.
 */
export type DbRow<T extends Table> = {
  [K in keyof Columns<T> as Columns<T>[K]["_"]["name"]]: Value<Columns<T>[K]>;
};

/** The columns a query selects: `sql<Row<typeof areas, "id" | "name">[]>`. */
export type Row<T extends Table, K extends keyof DbRow<T>> = Pick<DbRow<T>, K>;

/** The far side of a `LEFT JOIN`: a `NOT NULL` column still comes back null when nothing matched. */
export type LeftJoined<R> = { [K in keyof R]: R[K] | null };
