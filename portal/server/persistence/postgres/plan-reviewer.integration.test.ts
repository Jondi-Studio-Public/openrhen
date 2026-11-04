import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { previewReviewerDigest, runPlanReviewer } from "@openrhen/database";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_plan_reviewer");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const WEEK_LATER = new Date(NOW.getTime() + 7 * 86_400_000);

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
  sql = postgres(testUrl.toString(), { max: 4, connect_timeout: 10, fetch_types: false, prepare: true });
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, user_preferences, portal_state CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

async function finding(checkName: string, text: string, status = "open", decidedAt: Date | null = null) {
  await sql`
    INSERT INTO plan_findings (user_id, check_name, text, status, decided_at, created_at)
    VALUES (${userId}, ${checkName}, ${text}, ${status}, ${decidedAt}, ${NOW})`;
}

async function counts() {
  const [row] = await sql<{ log: string; outbox: string; findings: string }[]>`
    SELECT (SELECT count(*) FROM plan_shadow_log WHERE addon = 'reviewer') AS log,
           (SELECT count(*) FROM push_outbox) AS outbox,
           (SELECT count(*) FROM plan_findings) AS findings`;
  return { log: Number(row!.log), outbox: Number(row!.outbox), findings: Number(row!.findings) };
}

describe("plan map weekly reviewer", () => {
  it("queues one digest push, once a week", async () => {
    await finding("unit-code", "QRSTUV272 has no project");
    await finding("duplicate", "Two captures look the same", "accepted", daysAgo(2));
    await finding("duplicate", "An old dismissal", "dismissed", daysAgo(20));

    const first = await runPlanReviewer(sql, userId, NOW);
    expect(first.queued).toBe(true);
    const [push] = await sql<
      { kind: string; status: string; dedupe_key: string; payload: { title: string; body: string; tag: string } }[]
    >`
      SELECT kind, status, dedupe_key, payload FROM push_outbox`;
    expect(push).toMatchObject({ kind: "test", status: "pending", dedupe_key: "plan_digest:2026-10-01" });
    expect(push!.payload.title).toBe("Plan map week");
    expect(push!.payload.body).toContain("1 open finding (1 unit-code); 1 accepted, 0 dismissed this week.");

    const again = await runPlanReviewer(sql, userId, new Date(NOW.getTime() + 86_400_000));
    expect(again.ran).toBe(false);
    expect(await counts()).toMatchObject({ log: 1, outbox: 1 });

    const next = await runPlanReviewer(sql, userId, WEEK_LATER);
    expect(next.ran).toBe(true);
    expect(await counts()).toMatchObject({ log: 2, outbox: 2 });
  });

  it("holds the digest push for the person's wake time when the night sweep queues it", async () => {
    await finding("unit-code", "QRSTUV272 has no project");
    await sql`UPDATE users SET timezone='UTC' WHERE id=${userId}`;
    const [prefs] = await sql<{ wake: string | null }[]>`
      SELECT to_char(preferred_wake_time, 'HH24:MI') AS wake FROM user_preferences WHERE user_id=${userId}`;
    const night = new Date("2026-10-01T03:30:00.000Z");
    expect((await runPlanReviewer(sql, userId, night)).queued).toBe(true);
    const [row] = await sql<{ next_attempt_at: Date }[]>`SELECT next_attempt_at FROM push_outbox`;
    expect(row!.next_attempt_at.toISOString()).toBe(`2026-10-01T${prefs?.wake ?? "08:00"}:00.000Z`);
  });

  it("logs a quiet week without a push, and writes no plan data", async () => {
    const outcome = await runPlanReviewer(sql, userId, NOW);
    expect(outcome).toMatchObject({ ran: true, queued: false });
    expect(outcome.digest?.quiet).toBe(true);
    expect(await counts()).toMatchObject({ log: 1, outbox: 0, findings: 0 });
  });

  it("previews the digest without logging or sending", async () => {
    await finding("unit-code", "QRSTUV272 has no project");
    const digest = await previewReviewerDigest(sql, userId, NOW);
    expect(digest.lines.length).toBeGreaterThan(0);
    expect(await counts()).toMatchObject({ log: 0, outbox: 0 });
  });

  it("counts suggested and decided links and the explorer's shadow rows", async () => {
    const link = (to: string, status: string, decidedAt: Date | null) => sql`
      INSERT INTO plan_links (user_id, from_type, from_id, to_type, to_id, kind, status, proposer, evidence, decided_at)
      VALUES (${userId}, 'project', ${"p-" + to}, 'subject', ${to}, 'about', ${status}, 'owner', '[]'::jsonb, ${decidedAt})`;
    await link("maths", "suggested", null);
    await link("meals", "confirmed", daysAgo(1));
    await link("money", "rejected", daysAgo(30));
    const result = {
      answer: "x",
      itemIds: [],
      evidence: [],
      proposedChanges: [],
      calls: 3,
      tokens: { input: 3000, output: 1000 },
      ms: 800,
      incomplete: false,
      error: null
    };
    await sql`
      INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, would_have, reason, created_at)
      VALUES (${userId}, 'r1', 'explorer', 'task', 't1',
        ${sql.json({ backend: "haiku", model: "m", result, score: { recall: 1, precision: 1, f1: 1 }, cached: false } as never)}, '', ${daysAgo(1)})`;
    const outcome = await runPlanReviewer(sql, userId, NOW);
    expect(outcome.digest?.lines).toContain("1 suggested link waiting; 1 confirmed, 0 rejected this week.");
    expect(outcome.digest?.lines.some((line) => line.startsWith("Explorer: haiku F1 1.00, 4.0k tokens, 1 run."))).toBe(
      true
    );
  });
});
