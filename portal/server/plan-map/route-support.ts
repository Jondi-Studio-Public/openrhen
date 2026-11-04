import type { ZodType } from "zod";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool, type PoolSql } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/** The pool and the single user every plan-map route acts for, or the 503 to return when there is no database. */
export async function planMapContext(): Promise<{ sql: PoolSql; userId: string } | Response> {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The plan map requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  return { sql, userId: await ensureUser(sql) };
}

/** Parses a JSON body against `schema`, or returns the 400 to send. */
export async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<{ data: T } | Response> {
  let input: unknown = null;
  try {
    input = await request.json();
  } catch {
    /* validation below returns a safe error */
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: "The request failed validation.", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 }
    );
  return { data: parsed.data };
}
