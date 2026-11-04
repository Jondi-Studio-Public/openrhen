import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readProposerScores, runPlanMapProposers } from "./plan-map-proposers";
import {
  bulkConfirm,
  createManualLink,
  decideFinding,
  FindingQuestionsError,
  decideLink,
  listPlanMap,
  reopenFinding,
  setSwitch,
  sweepPlanMap
} from "./plan-map-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_plan_map");

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
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

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

async function createProject(title: string): Promise<string> {
  const area = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},${title},'active') RETURNING id`;
  return project[0]!.id;
}

async function createAction(projectId: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Work','one_off','active',10,20,30,20,'medium',10,30) RETURNING id`;
  return rows[0]!.id;
}

async function insertSuggestion(
  from: { type: string; id: string },
  to: { type: string; id: string },
  kind: string,
  overrides: { proposer?: string; createdAt?: Date; status?: string } = {}
): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO plan_links (user_id, from_type, from_id, to_type, to_id, kind, status, proposer, created_at)
    VALUES (${userId}, ${from.type}, ${from.id}, ${to.type}, ${to.id}, ${kind}, ${overrides.status ?? "suggested"},
      ${overrides.proposer ?? "rule:unit-code"}, ${overrides.createdAt ?? NOW})
    RETURNING id`;
  return rows[0]!.id;
}

describe("plan map store", () => {
  it("seeds the five starting subjects for a new user and lists every switch as off", async () => {
    const map = await listPlanMap(sql, userId);
    expect(map.subjects.map((subject) => subject.id).sort()).toEqual([
      "drafting",
      "exercise",
      "maths",
      "meals",
      "money"
    ]);
    expect(map.subjects.every((subject) => subject.status === "active")).toBe(true);
    expect(map.switches).toHaveLength(5);
    expect(map.switches.every((entry) => entry.mode === "off")).toBe(true);
    expect(map.links).toEqual([]);
    expect(map.findings).toEqual([]);
  });

  it("creates a confirmed manual link and returns it idempotently", async () => {
    const action = await createAction(await createProject("Uni prep"));
    const created = await createManualLink(
      sql,
      userId,
      { kind: "about", fromType: "action", fromId: action, toType: "subject", toId: "maths" },
      NOW
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.link).toMatchObject({ status: "confirmed", proposer: "owner", decidedAt: NOW.toISOString() });
    const again = await createManualLink(sql, userId, {
      kind: "about",
      fromType: "action",
      fromId: action,
      toType: "subject",
      toId: "maths"
    });
    expect(again.ok && again.link.id).toBe(created.link.id);
    expect((await listPlanMap(sql, userId)).links).toHaveLength(1);
  });

  it("lists the good rows when a stored link has a proposer the schema rejects", async () => {
    const project = await createProject("Maths exam");
    const good = await insertSuggestion({ type: "project", id: project }, { type: "subject", id: "maths" }, "about");
    const bad = await insertSuggestion({ type: "project", id: project }, { type: "subject", id: "meals" }, "about", {
      proposer: "test-agent"
    });
    const map = await listPlanMap(sql, userId);
    expect(map.links.map((link) => link.id)).toEqual([good]);
    expect(map.links.map((link) => link.id)).not.toContain(bad);
  });

  it("refuses invalid ends, self links and ends that do not exist", async () => {
    const project = await createProject("P");
    const action = await createAction(project);
    const wrongKind = await createManualLink(sql, userId, {
      kind: "before",
      fromType: "action",
      fromId: action,
      toType: "project",
      toId: project
    });
    expect(wrongKind).toMatchObject({ ok: false, code: "invalid_ends" });
    const self = await createManualLink(sql, userId, {
      kind: "prepares",
      fromType: "action",
      fromId: action,
      toType: "action",
      toId: action
    });
    expect(self).toMatchObject({ ok: false, code: "invalid_ends" });
    const missing = await createManualLink(sql, userId, {
      kind: "about",
      fromType: "action",
      fromId: action,
      toType: "subject",
      toId: "nope"
    });
    expect(missing).toMatchObject({ ok: false, code: "missing_end" });
    const missingUuid = await createManualLink(sql, userId, {
      kind: "about",
      fromType: "action",
      fromId: crypto.randomUUID(),
      toType: "subject",
      toId: "maths"
    });
    expect(missingUuid).toMatchObject({ ok: false, code: "missing_end" });
    expect((await listPlanMap(sql, userId)).links).toEqual([]);
  });

  it("confirms a suggestion in place when the same pair is linked by hand", async () => {
    const action = await createAction(await createProject("P"));
    const id = await insertSuggestion({ type: "action", id: action }, { type: "subject", id: "maths" }, "about");
    const result = await createManualLink(
      sql,
      userId,
      { kind: "about", fromType: "action", fromId: action, toType: "subject", toId: "maths" },
      NOW
    );
    expect(result.ok && result.link).toMatchObject({ id, status: "confirmed", proposer: "rule:unit-code" });
  });

  it("refuses a manual link over a rejected pair and revives it only through an explicit confirm", async () => {
    const action = await createAction(await createProject("P"));
    const id = await insertSuggestion({ type: "action", id: action }, { type: "subject", id: "maths" }, "about");
    expect(await decideLink(sql, userId, id, "reject", NOW)).toMatchObject({ ok: true, link: { status: "rejected" } });
    const manual = await createManualLink(sql, userId, {
      kind: "about",
      fromType: "action",
      fromId: action,
      toType: "subject",
      toId: "maths"
    });
    expect(manual).toMatchObject({ ok: false, code: "rejected_pair" });
    expect(await decideLink(sql, userId, id, "remove")).toMatchObject({ ok: false, code: "rejected_kept" });
    expect(await decideLink(sql, userId, id, "confirm", NOW)).toMatchObject({
      ok: true,
      link: { status: "confirmed", lastConfirmedAt: NOW.toISOString() }
    });
  });

  it("reopens a confirmed or rejected suggestion, takes its logged decision back, and leaves other links alone", async () => {
    const action = await createAction(await createProject("P"));
    const confirmedId = await insertSuggestion(
      { type: "action", id: action },
      { type: "subject", id: "maths" },
      "about"
    );
    const rejectedId = await insertSuggestion(
      { type: "action", id: action },
      { type: "subject", id: "meals" },
      "about"
    );
    await decideLink(sql, userId, confirmedId, "confirm", NOW);
    await decideLink(sql, userId, rejectedId, "reject", NOW);
    const logged = () =>
      sql<{ would_have: { linkId: string } }[]>`
        SELECT would_have FROM plan_shadow_log WHERE user_id = ${userId} AND run_id = 'decision'`;
    expect(await logged()).toHaveLength(2);

    expect(await decideLink(sql, userId, confirmedId, "reopen")).toMatchObject({
      ok: true,
      link: { status: "suggested", decidedAt: null, lastConfirmedAt: null }
    });
    expect(await decideLink(sql, userId, rejectedId, "reopen")).toMatchObject({
      ok: true,
      link: { status: "suggested", decidedAt: null }
    });
    expect(await logged()).toHaveLength(0);
    // Decided again, it counts once.
    await decideLink(sql, userId, confirmedId, "confirm", NOW);
    expect((await logged()).map((row) => row.would_have.linkId)).toEqual([confirmedId]);
    // Already suggested, hand-made, or missing: nothing to reopen.
    expect(await decideLink(sql, userId, rejectedId, "reopen")).toMatchObject({ ok: false, code: "not_decided" });
    const manual = await createManualLink(sql, userId, {
      kind: "about",
      fromType: "action",
      fromId: action,
      toType: "subject",
      toId: "money"
    });
    if (!manual.ok) throw new Error("setup");
    expect(await decideLink(sql, userId, manual.link.id, "reopen")).toMatchObject({ ok: false, code: "not_decided" });
    expect((await listPlanMap(sql, userId)).links.find((l) => l.id === manual.link.id)?.status).toBe("confirmed");
    expect(await decideLink(sql, userId, crypto.randomUUID(), "reopen")).toMatchObject({
      ok: false,
      code: "not_found"
    });
  });

  it("treats an owner link as hand-made: reopen leaves it and the proposer scores skip it", async () => {
    const action = await createAction(await createProject("P"));
    const id = await insertSuggestion({ type: "action", id: action }, { type: "subject", id: "maths" }, "about", {
      proposer: "owner",
      status: "confirmed"
    });
    expect(await decideLink(sql, userId, id, "reopen")).toMatchObject({ ok: false, code: "not_decided" });
    expect((await listPlanMap(sql, userId)).links.find((l) => l.id === id)?.status).toBe("confirmed");
    expect(await readProposerScores(sql, userId)).toEqual([]);
  });

  it("keeps a link decided when taking back its logged decision fails, so the rate never double-counts", async () => {
    const action = await createAction(await createProject("P"));
    const id = await insertSuggestion({ type: "action", id: action }, { type: "subject", id: "maths" }, "about");
    await decideLink(sql, userId, id, "confirm", NOW);
    await sql.unsafe(`
      CREATE FUNCTION refuse_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused'; END $$;
      CREATE TRIGGER refuse_delete BEFORE DELETE ON plan_shadow_log FOR EACH ROW EXECUTE FUNCTION refuse_delete();
    `);
    try {
      await expect(decideLink(sql, userId, id, "reopen")).rejects.toThrow(/refused/);
    } finally {
      await sql.unsafe("DROP TRIGGER refuse_delete ON plan_shadow_log; DROP FUNCTION refuse_delete();");
    }
    expect((await listPlanMap(sql, userId)).links.find((link) => link.id === id)?.status).toBe("confirmed");
  });

  it("removes a confirmed link and reports a missing one", async () => {
    const action = await createAction(await createProject("P"));
    const created = await createManualLink(sql, userId, {
      kind: "about",
      fromType: "action",
      fromId: action,
      toType: "subject",
      toId: "meals"
    });
    if (!created.ok) throw new Error("setup");
    expect(await decideLink(sql, userId, created.link.id, "remove")).toEqual({ ok: true, link: null });
    expect((await listPlanMap(sql, userId)).links).toEqual([]);
    expect(await decideLink(sql, userId, created.link.id, "confirm")).toMatchObject({ ok: false, code: "not_found" });
  });

  it("accepts and dismisses findings", async () => {
    const projectId = await createProject("Empty");
    const rows = await sql<{ id: string }[]>`
      INSERT INTO plan_findings (user_id, check_name, item_ids, text, evidence)
      VALUES (${userId}, 'empty-project', ${sql.json([`project:${projectId}`])}, 'Empty project', ${sql.json(["no actions"])})
      RETURNING id`;
    const dismissed = await decideFinding(sql, userId, rows[0]!.id, "dismiss", NOW);
    expect(dismissed).toMatchObject({
      status: "dismissed",
      decidedAt: NOW.toISOString(),
      itemIds: [`project:${projectId}`]
    });
    expect(await decideFinding(sql, userId, rows[0]!.id, "accept", NOW)).toMatchObject({ status: "accepted" });
    expect(await decideFinding(sql, userId, crypto.randomUUID(), "accept")).toBeNull();
  });

  it("drops a finding's handles for items that no longer exist, across the uuid-backed and slug types", async () => {
    const keep = await createProject("Keep");
    const gone = await createProject("Gone");
    const action = await createAction(keep);
    const subject = (
      await sql<
        { id: string }[]
      >`INSERT INTO plan_subjects (id, user_id, name) VALUES ('test-subject', ${userId}, 'Test subject') RETURNING id`
    )[0]!.id;
    const handles = [
      `project:${keep}`,
      `project:${gone}`,
      `action:${action}`,
      `action:${crypto.randomUUID()}`,
      "project:not-a-uuid",
      `subject:${subject}`,
      "subject:vanished",
      "bare-id"
    ];
    await sql`
      INSERT INTO plan_findings (user_id, check_name, item_ids, text, evidence)
      VALUES (${userId}, 'empty-project', ${sql.json(handles)}, 'Stale', ${sql.json([])})`;
    await sql`DELETE FROM projects WHERE id = ${gone}`;
    const [finding] = (await listPlanMap(sql, userId)).findings;
    expect(finding!.itemIds).toEqual([`project:${keep}`, `action:${action}`, `subject:${subject}`, "bare-id"]);
    // The stored row is untouched: the drop is a read-time rule.
    const stored = await sql<{ item_ids: string[] }[]>`SELECT item_ids FROM plan_findings`;
    expect(stored[0]!.item_ids).toEqual(handles);
  });

  it("reopens an accepted or dismissed finding, and leaves an open or missing one", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO plan_findings (user_id, check_name, item_ids, text, evidence)
      VALUES (${userId}, 'empty-project', ${sql.json(["project:x"])}, 'Empty project', ${sql.json([])})
      RETURNING id`;
    const id = rows[0]!.id;
    expect(await reopenFinding(sql, userId, id)).toMatchObject({ ok: false, code: "not_decided" });
    await decideFinding(sql, userId, id, "dismiss", NOW);
    expect(await reopenFinding(sql, userId, id)).toMatchObject({
      ok: true,
      finding: { status: "open", decidedAt: null }
    });
    await decideFinding(sql, userId, id, "accept", NOW);
    expect(await reopenFinding(sql, userId, id)).toMatchObject({
      ok: true,
      finding: { status: "open", decidedAt: null }
    });
    expect(await reopenFinding(sql, userId, crypto.randomUUID())).toMatchObject({ ok: false, code: "not_found" });
  });

  it("accepts a finding that asks a question only once it is answered, and keeps the answer", async () => {
    const question = { field: "subject", question: "Which subject is this about?", suggestions: ["Maths", "Meals"] };
    const rows = await sql<{ id: string }[]>`
      INSERT INTO plan_findings (user_id, check_name, item_ids, text, evidence, questions)
      VALUES (${userId}, 'jev-ask', ${sql.json(["action:x"])}, 'Which subject?', ${sql.json([])}, ${sql.json([question])})
      RETURNING id`;
    const id = rows[0]!.id;
    expect((await listPlanMap(sql, userId)).findings[0]!.questions).toEqual([question]);
    await expect(decideFinding(sql, userId, id, "accept", NOW)).rejects.toBeInstanceOf(FindingQuestionsError);
    await expect(decideFinding(sql, userId, id, "accept", NOW, { subject: " " })).rejects.toBeInstanceOf(
      FindingQuestionsError
    );
    expect((await listPlanMap(sql, userId)).findings[0]!.status).toBe("open");
    const accepted = await decideFinding(sql, userId, id, "accept", NOW, { subject: " Maths " });
    expect(accepted).toMatchObject({ status: "accepted", questions: [{ ...question, answer: "Maths" }] });
  });

  it("dismisses a finding that asks a question without an answer", async () => {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO plan_findings (user_id, check_name, item_ids, text, evidence, questions)
      VALUES (${userId}, 'jev-ask', ${sql.json([])}, 'Which subject?', ${sql.json([])},
        ${sql.json([{ field: "subject", question: "Which?" }])})
      RETURNING id`;
    expect(await decideFinding(sql, userId, rows[0]!.id, "dismiss", NOW)).toMatchObject({ status: "dismissed" });
  });

  it("bulk-confirms suggestions for one proposer and kind only", async () => {
    const project = await createProject("P");
    const a = await createAction(project);
    const b = await createAction(project);
    await insertSuggestion({ type: "action", id: a }, { type: "subject", id: "maths" }, "about");
    await insertSuggestion({ type: "action", id: b }, { type: "subject", id: "maths" }, "about");
    await insertSuggestion({ type: "action", id: a }, { type: "subject", id: "meals" }, "about", {
      proposer: "model:haiku"
    });
    await insertSuggestion({ type: "action", id: a }, { type: "action", id: b }, "prepares");
    expect(await bulkConfirm(sql, userId, "rule:unit-code", "about", NOW)).toHaveLength(2);
    const statuses = (await listPlanMap(sql, userId)).links
      .map((link) => `${link.proposer}/${link.kind}/${link.status}`)
      .sort();
    expect(statuses).toEqual([
      "model:haiku/about/suggested",
      "rule:unit-code/about/confirmed",
      "rule:unit-code/about/confirmed",
      "rule:unit-code/prepares/suggested"
    ]);
  });

  it("sets a switch, overwrites it, and rejects a mode outside off, shadow and on", async () => {
    await setSwitch(sql, userId, "nudge", "shadow");
    await setSwitch(sql, userId, "nudge", "on", NOW);
    const map = await listPlanMap(sql, userId);
    expect(map.switches.find((entry) => entry.addon === "nudge")?.mode).toBe("on");
    expect(map.switches.find((entry) => entry.addon === "executor")?.mode).toBe("off");
    await expect(setSwitch(sql, userId, "nudge", "maybe" as never)).rejects.toThrow();
  });

  it("enforces the status, weight and uniqueness constraints in the database", async () => {
    const action = await createAction(await createProject("P"));
    await insertSuggestion({ type: "action", id: action }, { type: "subject", id: "maths" }, "about");
    await expect(
      insertSuggestion({ type: "action", id: action }, { type: "subject", id: "maths" }, "about")
    ).rejects.toThrow(/plan_links_pair_unique/);
    await expect(
      insertSuggestion({ type: "action", id: action }, { type: "subject", id: "meals" }, "about", { status: "weird" })
    ).rejects.toThrow(/plan_links_status_check/);
    await expect(
      sql`INSERT INTO plan_links (user_id, from_type, from_id, to_type, to_id, kind, weight, proposer)
          VALUES (${userId}, 'action', ${action}, 'subject', 'money', 'about', 1.5, 'owner')`
    ).rejects.toThrow(/plan_links_weight_check/);
  });

  it("sweeps orphaned links, expires old suggestions and prunes the shadow log", async () => {
    const project = await createProject("P");
    const kept = await createAction(project);
    const gone = await createAction(project);
    await insertSuggestion({ type: "action", id: kept }, { type: "subject", id: "maths" }, "about", {
      createdAt: daysAgo(31)
    });
    await insertSuggestion({ type: "action", id: kept }, { type: "subject", id: "meals" }, "about", {
      createdAt: daysAgo(5)
    });
    await insertSuggestion({ type: "action", id: kept }, { type: "subject", id: "money" }, "about", {
      status: "confirmed",
      createdAt: daysAgo(90)
    });
    await insertSuggestion({ type: "action", id: gone }, { type: "subject", id: "maths" }, "about", {
      status: "confirmed"
    });
    await insertSuggestion({ type: "action", id: kept }, { type: "subject", id: "retired" }, "about");
    await sql`DELETE FROM actions WHERE id = ${gone}`;
    await sql`INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, created_at) VALUES (${userId}, 'r1', 'nudge', 'action', ${kept}, ${daysAgo(61)})`;
    await sql`INSERT INTO plan_shadow_log (user_id, run_id, addon, item_type, item_id, created_at) VALUES (${userId}, 'r2', 'nudge', 'action', ${kept}, ${daysAgo(59)})`;

    const counts = await sweepPlanMap(sql, userId, NOW);
    expect(counts).toEqual({ orphanedLinksDeleted: 2, suggestionsExpired: 1, shadowRowsDeleted: 1 });
    const links = (await listPlanMap(sql, userId)).links;
    expect(links.map((link) => `${link.toId}/${link.status}`).sort()).toEqual([
      "maths/expired",
      "meals/suggested",
      "money/confirmed"
    ]);
    const shadow = await sql<{ run_id: string }[]>`SELECT run_id FROM plan_shadow_log`;
    expect(shadow.map((row) => row.run_id)).toEqual(["r2"]);
    expect(await sweepPlanMap(sql, userId, NOW)).toEqual({
      orphanedLinksDeleted: 0,
      suggestionsExpired: 0,
      shadowRowsDeleted: 0
    });
  });

  it("sweeps a contact link when the contact condition is deleted", async () => {
    const project = await createProject("P");
    await sql`INSERT INTO condition_definitions (user_id, id, name, kind) VALUES (${userId}, 'trainer', 'Trainer', 'contact')`;
    const created = await createManualLink(sql, userId, {
      kind: "involves",
      fromType: "project",
      fromId: project,
      toType: "contact",
      toId: "trainer"
    });
    expect(created.ok).toBe(true);
    expect((await sweepPlanMap(sql, userId, NOW)).orphanedLinksDeleted).toBe(0);
    await sql`DELETE FROM condition_definitions WHERE user_id = ${userId} AND id = 'trainer'`;
    expect((await sweepPlanMap(sql, userId, NOW)).orphanedLinksDeleted).toBe(1);
  });

  it("cascades every plan map row when the user is deleted", async () => {
    await setSwitch(sql, userId, "nudge", "shadow");
    await sql`DELETE FROM users WHERE id = ${userId}`;
    for (const table of ["plan_subjects", "plan_links", "plan_findings", "plan_shadow_log", "plan_map_switches"]) {
      const rows = await sql.unsafe(`SELECT 1 FROM ${table}`);
      expect(rows).toHaveLength(0);
    }
  });
});

describe("rule proposers", () => {
  beforeEach(async () => {
    await sql`UPDATE user_preferences SET plan_code_pattern = ${CODE_PATTERN} WHERE user_id = ${userId}`;
  });

  async function createRule(title: string): Promise<string> {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_unit,interval_weeks,weekdays,local_start_time,local_end_time)
      VALUES (${userId},${title},'Australia/Brisbane','2026-09-01','weeks',1,${sql.json([2] as never)},'09:00','12:00') RETURNING id`;
    return rows[0]!.id;
  }

  it("suggests an occurrence link on the recurring rule and an about link, once, and logs both", async () => {
    expect(
      (await listPlanMap(sql, userId)).switches.find((entry) => (entry.addon as string) === "proposers")
    ).toBeUndefined();
    const project = await createProject("QRSTUV272 Sustainability");
    const rule = await createRule("QRSTUV272 class");
    const action = await createAction(project);
    await sql`UPDATE actions SET title = 'Meal prep Sunday' WHERE id = ${action}`;
    const first = await runPlanMapProposers(sql, userId, NOW);
    expect(first.suggested).toBe(2);
    const links = (await listPlanMap(sql, userId)).links;
    expect(links.map((l) => [l.kind, l.status, l.proposer]).sort()).toEqual([
      ["about", "suggested", "rule:subject-words"],
      ["occurrence_of", "suggested", "rule:unit-code-occurrence"]
    ]);
    expect(links.find((l) => l.kind === "occurrence_of")).toMatchObject({ fromId: rule, toId: project });
    expect((await runPlanMapProposers(sql, userId, NOW)).suggested).toBe(0);
    const log = await sql<
      { would_have: { action: string } }[]
    >`SELECT would_have FROM plan_shadow_log WHERE user_id = ${userId} AND addon = 'proposers'`;
    expect(log.filter((row) => row.would_have.action === "suggest")).toHaveLength(2);
  });

  it("suggests no code link while the code pattern is null", async () => {
    await sql`UPDATE user_preferences SET plan_code_pattern = NULL WHERE user_id = ${userId}`;
    await createProject("QRSTUV272 Sustainability");
    await createRule("QRSTUV272 class");
    expect((await runPlanMapProposers(sql, userId, NOW)).suggested).toBe(0);
    expect((await listPlanMap(sql, userId)).links).toEqual([]);
  });

  it("never proposes a rejected pair again, and logs accept and reject decisions with their rates", async () => {
    const project = await createProject("QRSTUV272 Sustainability");
    await createRule("QRSTUV272 class");
    const action = await createAction(project);
    await sql`UPDATE actions SET title = 'Go swimming' WHERE id = ${action}`;
    await runPlanMapProposers(sql, userId, NOW);
    const links = (await listPlanMap(sql, userId)).links;
    const about = links.find((l) => l.kind === "about")!;
    const occurrence = links.find((l) => l.kind === "occurrence_of")!;
    await decideLink(sql, userId, about.id, "reject", NOW);
    await decideLink(sql, userId, occurrence.id, "confirm", NOW);
    expect((await runPlanMapProposers(sql, userId, daysAgo(-1))).suggested).toBe(0);
    expect((await listPlanMap(sql, userId)).links.find((l) => l.id === about.id)?.status).toBe("rejected");
    const decisions = await sql<{ would_have: { action: string } }[]>`
      SELECT would_have FROM plan_shadow_log WHERE user_id = ${userId} AND run_id = 'decision' ORDER BY created_at`;
    expect(decisions.map((row) => row.would_have.action).sort()).toEqual(["accepted", "rejected"]);
    const scores = await readProposerScores(sql, userId);
    expect(scores.find((s) => s.kind === "about")).toMatchObject({ accepted: 0, rejected: 1, acceptRate: 0 });
    expect(scores.find((s) => s.kind === "occurrence_of")).toMatchObject({ accepted: 1, rejected: 0, acceptRate: 1 });
    const summary = await sql<{ would_have: { action: string } }[]>`
      SELECT would_have FROM plan_shadow_log WHERE user_id = ${userId} AND item_type = 'proposer'`;
    expect(summary.length).toBeGreaterThan(0);
  });

  it("expires a suggestion after 30 days and revives it only with new evidence", async () => {
    const project = await createProject("Study plan");
    const action = await createAction(project);
    await sql`UPDATE actions SET title = 'Go swimming' WHERE id = ${action}`;
    await runPlanMapProposers(sql, userId, daysAgo(40));
    await sweepPlanMap(sql, userId, NOW);
    expect((await listPlanMap(sql, userId)).links[0]?.status).toBe("expired");
    expect((await runPlanMapProposers(sql, userId, NOW)).revived).toBe(0);
    await sql`UPDATE actions SET title = 'Go to the gym' WHERE id = ${action}`;
    expect((await runPlanMapProposers(sql, userId, NOW)).revived).toBe(1);
    expect((await listPlanMap(sql, userId)).links[0]).toMatchObject({
      status: "suggested",
      proposer: "rule:subject-words"
    });
  });
});
