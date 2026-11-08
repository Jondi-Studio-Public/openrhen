import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readDerivedSettings, saveDerivedSettings } from "./derived-settings-store";

/**
 * Migration 0150 end to end: the settings store (defaults, merge, clear, per-user isolation, the CHECK backstop), the
 * append-only model-call audit (UPDATE refused, DELETE and the user cascade allowed, no content column), and the two
 * partial indexes (what they cover and that the planner can use them).
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_derived_settings");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

describe("derived settings store", () => {
  it("reads the defaults before anything is saved, without writing a row", async () => {
    expect(await readDerivedSettings(sql as never)).toEqual({
      ollamaUrl: null,
      t2Model: null,
      t3Model: null,
      t3DailyMessageCap: 50,
      t3DailyTokenCap: 200_000,
      backfillDays: 90,
      updatedAt: null
    });
    expect(await sql`SELECT 1 FROM derived_settings`).toHaveLength(0);
  });

  it("merges a patch into what is held, keeps fields left out, and clears a text field sent as null", async () => {
    const first = await saveDerivedSettings(sql as never, {
      ollamaUrl: "http://192.168.1.20:11434",
      t2Model: "qwen3:8b",
      backfillDays: 30
    });
    expect(first).toMatchObject({
      ollamaUrl: "http://192.168.1.20:11434",
      t2Model: "qwen3:8b",
      t3Model: null,
      backfillDays: 30,
      t3DailyMessageCap: 50
    });
    expect(first.updatedAt).not.toBeNull();
    const second = await saveDerivedSettings(sql as never, {
      t3Model: "meta/llama",
      t2Model: null,
      t3DailyMessageCap: 0
    });
    expect(second).toMatchObject({
      ollamaUrl: "http://192.168.1.20:11434",
      t2Model: null,
      t3Model: "meta/llama",
      backfillDays: 30,
      t3DailyMessageCap: 0
    });
    expect(await readDerivedSettings(sql as never)).toEqual(second);
    expect(await sql`SELECT 1 FROM derived_settings`).toHaveLength(1);
  });

  it("keeps both fields when two first-time saves race", async () => {
    for (let round = 0; round < 15; round++) {
      await sql`DELETE FROM derived_settings`;
      await Promise.all([
        saveDerivedSettings(sql as never, { t2Model: "qwen3:8b" }),
        saveDerivedSettings(sql as never, { backfillDays: 30 }),
        saveDerivedSettings(sql as never, { t3DailyMessageCap: 7 })
      ]);
      expect(await readDerivedSettings(sql as never), `round ${round}`).toMatchObject({
        t2Model: "qwen3:8b",
        backfillDays: 30,
        t3DailyMessageCap: 7
      });
    }
  });

  it("refuses over-long text at the database too", async () => {
    await expect(
      sql`INSERT INTO derived_settings (user_id, ollama_url) VALUES (${userId}, ${"http://" + "a".repeat(2050)})`
    ).rejects.toThrow(/derived_settings_ollama_url_check/);
    await expect(
      sql`INSERT INTO derived_settings (user_id, t2_model) VALUES (${userId}, ${"m".repeat(201)})`
    ).rejects.toThrow(/derived_settings_t2_model_check/);
    await expect(
      sql`INSERT INTO derived_settings (user_id, t3_model) VALUES (${userId}, ${"m".repeat(201)})`
    ).rejects.toThrow(/derived_settings_t3_model_check/);
    await sql`INSERT INTO derived_settings (user_id, ollama_url, t2_model, t3_model)
              VALUES (${userId}, ${"h".repeat(2048)}, ${"m".repeat(200)}, ${"m".repeat(200)})`;
  });

  it("keeps one person's settings from another's", async () => {
    await saveDerivedSettings(sql as never, { backfillDays: 10 });
    const [other] = await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Second') RETURNING id`;
    await sql`INSERT INTO derived_settings (user_id, backfill_days) VALUES (${other!.id}, 400)`;
    expect((await readDerivedSettings(sql as never)).backfillDays).toBe(10);
    const rows = await sql<
      { user_id: string; backfill_days: number }[]
    >`SELECT user_id, backfill_days FROM derived_settings`;
    expect(rows).toHaveLength(2);
  });

  it("is backstopped by CHECK constraints, so a route bug cannot store an out-of-range value", async () => {
    await expect(sql`INSERT INTO derived_settings (user_id, backfill_days) VALUES (${userId}, 0)`).rejects.toThrow(
      /derived_settings_backfill_days_check/
    );
    await expect(
      sql`INSERT INTO derived_settings (user_id, t3_daily_message_cap) VALUES (${userId}, -1)`
    ).rejects.toThrow(/derived_settings_t3_message_cap_check/);
    await expect(
      sql`INSERT INTO derived_settings (user_id, t3_daily_token_cap) VALUES (${userId}, 100000001)`
    ).rejects.toThrow(/derived_settings_t3_token_cap_check/);
  });

  it("is deleted with the person", async () => {
    await saveDerivedSettings(sql as never, { backfillDays: 10 });
    await sql`DELETE FROM users WHERE id = ${userId}`;
    expect(await sql`SELECT 1 FROM derived_settings`).toHaveLength(0);
  });
});

describe("derived_model_calls", () => {
  const insert = () =>
    sql`INSERT INTO derived_model_calls (user_id, source_event_key, tier, model, tokens_in, tokens_out, reason)
        VALUES (${userId}, 'gmail:thread-1', 't3', 'meta/llama', 900, 120, 'ok') RETURNING id`;

  it("stores a row with the audit columns only: no content, no key", async () => {
    await insert();
    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'derived_model_calls' ORDER BY ordinal_position`;
    expect(columns.map((c) => c.column_name)).toEqual([
      "id",
      "user_id",
      "source_event_key",
      "at",
      "tier",
      "model",
      "tokens_in",
      "tokens_out",
      "reason"
    ]);
    const [row] = await sql<{ at: Date }[]>`SELECT at FROM derived_model_calls`;
    expect(Math.abs(row!.at.getTime() - Date.now())).toBeLessThan(60_000);
  });

  it("refuses any UPDATE with the append-only message, but allows DELETE", async () => {
    const [row] = await insert();
    await expect(sql`UPDATE derived_model_calls SET tokens_in = 1 WHERE id = ${row!.id}`).rejects.toThrow(
      /derived_model_calls is append-only/
    );
    await expect(sql`UPDATE derived_model_calls SET reason = 'x'`).rejects.toThrow(/append-only/);
    expect(await sql`SELECT 1 FROM derived_model_calls WHERE tokens_in = 900`).toHaveLength(1);
    await sql`DELETE FROM derived_model_calls WHERE id = ${row!.id}`;
    expect(await sql`SELECT 1 FROM derived_model_calls`).toHaveLength(0);
  });

  it("is removed by the user cascade despite the trigger", async () => {
    await insert();
    await sql`DELETE FROM users WHERE id = ${userId}`;
    expect(await sql`SELECT 1 FROM derived_model_calls`).toHaveLength(0);
  });

  it("refuses an unknown tier, negative tokens, over-long text and a call for a missing user", async () => {
    await expect(
      sql`INSERT INTO derived_model_calls (user_id, source_event_key, tier, model, reason) VALUES (${userId}, 'k', 't1', 'm', 'ok')`
    ).rejects.toThrow(/derived_model_calls_tier_check/);
    await expect(
      sql`INSERT INTO derived_model_calls (user_id, source_event_key, tier, model, tokens_in, reason) VALUES (${userId}, 'k', 't2', 'm', -1, 'ok')`
    ).rejects.toThrow(/derived_model_calls_tokens_check/);
    await expect(
      sql`INSERT INTO derived_model_calls (user_id, source_event_key, tier, model, reason) VALUES (${userId}, 'k', 't2', 'm', ${"x".repeat(201)})`
    ).rejects.toThrow(/derived_model_calls_short_text_check/);
    await expect(
      sql`INSERT INTO derived_model_calls (user_id, source_event_key, tier, model, reason) VALUES ('00000000-0000-4000-8000-000000000000', 'k', 't2', 'm', 'ok')`
    ).rejects.toThrow(/derived_model_calls_user_id_users_id_fk/);
  });
});

describe("the fact and derived indexes", () => {
  const index = async (name: string) =>
    (
      await sql<
        { indexdef: string }[]
      >`SELECT indexdef FROM pg_indexes WHERE tablename = 'activity_events' AND indexname = ${name}`
    )[0]?.indexdef;

  it("are partial, so raw mail rows are not indexed", async () => {
    const fact = await index("activity_events_fact_id_idx");
    expect(fact).toContain("(attrs ->> 'fact_id'::text)");
    expect(fact).toMatch(/WHERE \(?kind = 'fact'/);
    const derived = await index("activity_events_derived_idx");
    expect(derived).toContain("user_id, source, kind");
    expect(derived).toMatch(/WHERE .*source = ANY \(ARRAY\['derived'::text, 'derived-shadow'::text\]\)/);
  });

  it("hold only the rows their predicate covers, and the planner uses them", async () => {
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
              SELECT ${userId}, 'gmail', 'message', 'm' || g, now(), '{}'::jsonb FROM generate_series(1, 2000) g`;
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
              SELECT ${userId}, 'derived', 'fact', 'f' || g, now(), jsonb_build_object('fact_id', 'id' || g) FROM generate_series(1, 50) g`;
    await sql`ANALYZE activity_events`;
    const [sizes] = await sql<{ fact: string; all: string }[]>`
      SELECT pg_relation_size('activity_events_fact_id_idx') AS fact,
             pg_relation_size('activity_events_user_source_time_idx') AS "all"`;
    expect(Number(sizes!.fact)).toBeLessThan(Number(sizes!.all));
    await sql.unsafe("SET enable_seqscan = off");
    try {
      const byFact = await sql.unsafe(
        `EXPLAIN SELECT id FROM activity_events WHERE user_id = '${userId}' AND kind = 'fact' AND attrs->>'fact_id' = 'id7'`
      );
      expect(byFact.map((row) => String(row["QUERY PLAN"])).join("\n")).toContain("activity_events_fact_id_idx");
      const byKind = await sql.unsafe(
        `EXPLAIN SELECT id FROM activity_events WHERE user_id = '${userId}' AND source = 'derived' AND kind = 'fact'`
      );
      expect(byKind.map((row) => String(row["QUERY PLAN"])).join("\n")).toMatch(
        /activity_events_(derived|user_source)/
      );
    } finally {
      await sql.unsafe("RESET enable_seqscan");
    }
  });
});
