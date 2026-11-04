import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { withIngestLock } from "./ingest-lock";

/**
 * `withIngestLock` must never leave an advisory lock behind: a pass that throws, or a pooled
 * connection reused afterwards, may not keep later passes waiting. The lock is transaction-scoped, so
 * it is released with the transaction whatever the pass does. Runs against the admin database, which
 * the lock does not write to.
 */
const adminUrl = process.env.POSTGRES_ADMIN_URL;
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");

let sql: postgres.Sql;

beforeAll(() => {
  // A small pool, so a connection that kept its lock would be reused and block the next pass.
  sql = postgres(adminUrl, { max: 2, connect_timeout: 10 });
});

afterAll(async () => {
  await sql?.end();
});

async function advisoryLocksHeld(): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`;
  return rows[0]!.count;
}

describe("withIngestLock", () => {
  it("runs passes of one key one at a time", async () => {
    const order: string[] = [];
    const pass = (name: string) => async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      order.push(`${name}:end`);
    };
    await Promise.all([withIngestLock(sql, "test-serial", pass("a")), withIngestLock(sql, "test-serial", pass("b"))]);
    expect(order[0]!.endsWith(":start")).toBe(true);
    expect(order[1]).toBe(order[0]!.replace(":start", ":end"));
  });

  it("leaves no lock held when a pass throws, so the next pass runs at once", async () => {
    for (let attempt = 0; attempt < 4; attempt++)
      await expect(
        withIngestLock(sql, "test-throw", async () => {
          throw new Error("pass failed");
        })
      ).rejects.toThrow("pass failed");
    expect(await advisoryLocksHeld()).toBe(0);
    await expect(withIngestLock(sql, "test-throw", async () => "ran")).resolves.toBe("ran");
    expect(await advisoryLocksHeld()).toBe(0);
  });
});
