import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { runPlanHealth } from "./plan-health-store";
import { decideFinding, listPlanMap } from "./plan-map-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_plan_health");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
const CODE_PATTERN = String.raw`\b(?![A-Z]{3}[5-9]\d{4}\b)(?:[A-Z]{3,7}\d{3,4}[A-Z]?|[A-Z]{3}\d{5})\b`;
const NOW = new Date("2026-10-01T00:00:00.000Z");
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000);

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
  await sql`UPDATE user_preferences SET plan_code_pattern = ${CODE_PATTERN} WHERE user_id = ${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

async function seedPlan(): Promise<{ projectId: string; deliverableId: string }> {
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'College','active',0) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Pass','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,external_deadline_at)
    VALUES (${outcome[0]!.id},'ABC10004 Technical drawing','active',${daysFromNow(-10)}) RETURNING id`;
  const deliverable = await sql<{ id: string }[]>`
    INSERT INTO deliverables (project_id,title,status,external_deadline_at)
    VALUES (${project[0]!.id},'Assessment 1','needs_breakdown',${daysFromNow(-3)}) RETURNING id`;
  await sql`
    INSERT INTO deliverable_blockers (deliverable_id,description,category,state)
    VALUES (${deliverable[0]!.id},'Waiting for the trainer','waiting_on_someone','open')`;
  await sql`
    INSERT INTO commitments (user_id,title,starts_at,ends_at,status)
    VALUES (${userId},'ABC10001 lecture',${daysFromNow(2)},${daysFromNow(2.05)},'confirmed')`;
  for (const [externalId, title] of [
    ["m1", "Book dentist"],
    ["m2", "Re: Book dentist"]
  ] as const) {
    const source = await sql<{ id: string }[]>`
      INSERT INTO sources (user_id,source_type,external_id,title) VALUES (${userId},'email',${externalId},${title}) RETURNING id`;
    await sql`
      INSERT INTO captures (user_id,source_id,proposal_type,status,proposed_fields)
      VALUES (${userId},${source[0]!.id},'action','pending',${sql.json({ title: "Book dentist" } as never)})`;
  }
  return { projectId: project[0]!.id, deliverableId: deliverable[0]!.id };
}

describe("runPlanHealth", () => {
  it("writes findings with no switch row, raises none twice, and never re-raises a dismissed one", async () => {
    const { projectId, deliverableId } = await seedPlan();

    const first = await runPlanHealth(sql, userId, NOW);
    expect(first.mode).toBe("on");
    expect(first.created).toBe(first.found);
    const findings = (await listPlanMap(sql, userId)).findings;
    const byCheck = (name: string) => findings.filter((finding) => finding.checkName === name);
    expect(
      byCheck("stale_deadline")
        .map((f) => f.itemIds[0])
        .sort()
    ).toEqual([`deliverable:${deliverableId}`, `project:${projectId}`].sort());
    expect(byCheck("empty_assessment")).toHaveLength(1);
    expect(byCheck("blocker_no_person")).toHaveLength(1);
    expect(
      byCheck("unit_code_no_project")
        .map((f) => f.text)
        .join(" ")
    ).toContain("ABC10001");
    expect(
      byCheck("unit_code_no_project")
        .map((f) => f.text)
        .join(" ")
    ).not.toContain("ABC10004");
    expect(byCheck("duplicate_captures")).toHaveLength(1);
    expect(findings.every((f) => f.status === "open")).toBe(true);

    expect(await runPlanHealth(sql, userId, daysFromNow(1))).toMatchObject({ created: 0 });

    const dismissed = byCheck("empty_assessment")[0]!;
    await decideFinding(sql, userId, dismissed.id, "dismiss", NOW);
    expect(await runPlanHealth(sql, userId, daysFromNow(2))).toMatchObject({ created: 0 });
    const after = (await listPlanMap(sql, userId)).findings;
    expect(after).toHaveLength(findings.length);
    expect(after.find((f) => f.id === dismissed.id)?.status).toBe("dismissed");
  });

  it("clears an open finding once its gap closes, and keeps decided ones", async () => {
    const { deliverableId } = await seedPlan();
    await runPlanHealth(sql, userId, NOW);
    const before = (await listPlanMap(sql, userId)).findings;
    const empty = before.find((f) => f.checkName === "empty_assessment")!;
    const stale = before.find(
      (f) => f.checkName === "stale_deadline" && f.itemIds[0] === `deliverable:${deliverableId}`
    )!;
    await decideFinding(sql, userId, stale.id, "dismiss", NOW);
    await sql`INSERT INTO deliverable_criteria (deliverable_id,key,title) VALUES (${deliverableId},'k1','Criterion')`;
    await sql`UPDATE deliverables SET external_deadline_at = ${daysFromNow(30)} WHERE id = ${deliverableId}`;

    const run = await runPlanHealth(sql, userId, daysFromNow(1));
    expect(run.cleared).toBe(1);
    const after = (await listPlanMap(sql, userId)).findings;
    expect(after.find((f) => f.id === empty.id)).toBeUndefined();
    expect(after.find((f) => f.id === stale.id)?.status).toBe("dismissed");
  });

  it("changes no plan row", async () => {
    await seedPlan();
    const before =
      await sql`SELECT (SELECT count(*) FROM projects) p, (SELECT count(*) FROM deliverables) d, (SELECT count(*) FROM actions) a, (SELECT count(*) FROM plan_links) l`;
    await runPlanHealth(sql, userId, NOW);
    const after =
      await sql`SELECT (SELECT count(*) FROM projects) p, (SELECT count(*) FROM deliverables) d, (SELECT count(*) FROM actions) a, (SELECT count(*) FROM plan_links) l`;
    expect(after).toEqual(before);
  });
});
