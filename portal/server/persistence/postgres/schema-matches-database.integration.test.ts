import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { is } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getTableConfig, PgDialect, PgTable } from "drizzle-orm/pg-core";
import postgres from "postgres";
import { resolve } from "node:path";
import * as database from "@openrhen/database";
import { integrationDatabaseName } from "@openrhen/database";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_schema_match");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

/** The family of a Drizzle `getSQLType()` string (`timestamp with time zone`, `varchar(255)`, `text[]`, an enum's name). */
function schemaFamily(sqlType: string, enumNames: Set<string>): string {
  const type = sqlType
    .toLowerCase()
    .replace(/\(.*\)/, "")
    .trim();
  if (type.endsWith("[]")) return `array of ${schemaFamily(type.slice(0, -2), enumNames)}`;
  if (type === "timestamp with time zone" || type === "timestamptz") return "timestamptz";
  if (type === "timestamp" || type === "timestamp without time zone") return "timestamp";
  if (type === "time" || type === "time without time zone") return "time";
  if (type === "integer" || type === "int" || type === "int4" || type === "serial") return "int4";
  if (type === "smallint" || type === "int2" || type === "smallserial") return "int2";
  if (type === "bigint" || type === "int8" || type === "bigserial") return "int8";
  if (type === "boolean" || type === "bool") return "bool";
  if (type === "text" || type === "varchar" || type === "character varying") return "text";
  if (type === "double precision") return "float8";
  if (type === "real") return "float4";
  if (enumNames.has(type) || enumNames.has(sqlType)) return `enum ${sqlType}`;
  return type;
}

/** The family of an `information_schema.columns` row, spelled the same way as `schemaFamily`. */
function databaseFamily(dataType: string, udtName: string): string {
  if (dataType === "ARRAY") return `array of ${databaseFamily("", udtName.replace(/^_/, ""))}`;
  if (dataType === "USER-DEFINED") return `enum ${udtName}`;
  if (udtName === "bpchar" || udtName === "varchar") return "text";
  return udtName;
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists
    `;
    if (!existing[0]?.exists) await admin.unsafe(`CREATE DATABASE "${testDatabaseName}"`);
  } finally {
    await admin.end();
  }
  const migrationSql = postgres(testUrl.toString(), { max: 1, connect_timeout: 10 });
  try {
    await migrate(drizzle(migrationSql), { migrationsFolder: resolve(process.cwd(), "../platform/database/drizzle") });
  } finally {
    await migrationSql.end();
  }
  sql = postgres(testUrl.toString(), { max: 2, connect_timeout: 10, fetch_types: false });
}, 60_000);

afterAll(async () => {
  await sql?.end();
});

describe("schema.ts against the migrated database", () => {
  it("declares every column the migrations created, with the same nullability and type family", async () => {
    const columns = await sql<
      { table_name: string; column_name: string; is_nullable: string; data_type: string; udt_name: string }[]
    >`
      SELECT table_name, column_name, is_nullable, data_type, udt_name
      FROM information_schema.columns WHERE table_schema = 'public'
    `;
    const enums = await sql<{ typname: string }[]>`SELECT typname FROM pg_type WHERE typtype = 'e'`;
    const enumNames = new Set(enums.map((row) => row.typname));
    const actual = new Map(columns.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    const tables = [
      ...new Set(
        Object.values(database as Record<string, unknown>).filter((value): value is PgTable => is(value, PgTable))
      )
    ];
    expect(tables.length).toBeGreaterThan(30);

    const mismatches: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        const key = `${config.name}.${column.name}`;
        const found = actual.get(key);
        if (!found) {
          mismatches.push(`${key}: declared in schema.ts, missing from the migrated database`);
          continue;
        }
        const declaredNullable = !column.notNull;
        const databaseNullable = found.is_nullable === "YES";
        if (declaredNullable !== databaseNullable) {
          mismatches.push(
            `${key}: nullability, schema.ts says ${declaredNullable ? "nullable" : "NOT NULL"}, database says ${databaseNullable ? "nullable" : "NOT NULL"}`
          );
        }
        const declaredFamily = schemaFamily(column.getSQLType(), enumNames);
        const databaseType = databaseFamily(found.data_type, found.udt_name);
        if (declaredFamily !== databaseType) {
          mismatches.push(
            `${key}: type, schema.ts says ${declaredFamily} (${column.getSQLType()}), database says ${databaseType}`
          );
        }
      }
    }
    // The other way round: a column the migrations created on a table `schema.ts` owns, but that it
    // never declares, is invisible to every typed read and to the next generated migration.
    const declared = new Set(
      tables.flatMap((table) => {
        const config = getTableConfig(table);
        return config.columns.map((column) => `${config.name}.${column.name}`);
      })
    );
    const ownedTables = new Set(tables.map((table) => getTableConfig(table).name));
    for (const key of actual.keys()) {
      if (ownedTables.has(key.split(".")[0]!) && !declared.has(key)) {
        mismatches.push(`${key}: in the migrated database, not declared in schema.ts`);
      }
    }
    expect(mismatches.sort().join("\n")).toBe("");
  });

  it("gives every CHECK constraint schema.ts declares the same allowed values as the migrated database", async () => {
    const rows = await sql<{ table_name: string; conname: string; definition: string }[]>`
      SELECT cls.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
      FROM pg_constraint con
      JOIN pg_class cls ON cls.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cls.relnamespace
      WHERE con.contype = 'c' AND ns.nspname = 'public'
    `;
    const actual = new Map(rows.map((row) => [`${row.table_name}.${row.conname}`, row.definition]));
    const tables = [
      ...new Set(
        Object.values(database as Record<string, unknown>).filter((value): value is PgTable => is(value, PgTable))
      )
    ];
    const literals = (text: string) => [...text.matchAll(/'([^']*)'/g)].map((match) => match[1]!).sort();
    const dialect = new PgDialect();
    const mismatches: string[] = [];
    for (const table of tables) {
      const config = getTableConfig(table);
      for (const check of config.checks) {
        const key = `${config.name}.${check.name}`;
        const definition = actual.get(key);
        if (definition === undefined) {
          mismatches.push(`${key}: declared in schema.ts, missing from the migrated database`);
          continue;
        }
        const declaredValues = literals(dialect.sqlToQuery(check.value).sql);
        const databaseValues = literals(definition);
        if (declaredValues.join("|") !== databaseValues.join("|")) {
          mismatches.push(
            `${key}: values, schema.ts says [${declaredValues.join(", ")}], database says [${databaseValues.join(", ")}]`
          );
        }
      }
    }
    expect(mismatches.sort().join("\n")).toBe("");
  });
});
