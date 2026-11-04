import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import type { CloseEntityCommand, GoogleCalendarEvent } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { runWithActor } from "@/server/agent-actor";
import { createSeedState } from "@/state/portal-state";
import { runActivityCommand } from "../activity-commands";
import { closeEntity } from "../close-commands";
import { ForbiddenCommandError } from "../command-errors";
import { ensureUser } from "../ensure-user";
import { PostgresImportStore } from "../import-store";
import { NormalizedPostgresStateStore } from "../state-store";
import { closeCommitmentAsSystem } from "../system-close";
import { toCalendarEvent } from "./calendar-profiles/google-event-fixtures";

/**
 * A calendar cancellation cancels the commitment instead of deleting it (archive-removals design section 7, PR 7a):
 * stamped as the source's removal, with its steps and safe prep actions, restorable from the Closed page, reopened by the
 * same source when the event comes back, never reopened when a person cancelled it, and counted by the close brake.
 * Driven through the Google Calendar preview and commit. Its own `_test` database.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_source_cancel");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) throw new Error("TEST_DATABASE_NAME must end in _test");
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let store: NormalizedPostgresStateStore;
let importStore: PostgresImportStore;
let userId: string;

const CAL = "jon@example.com";
const window = {
  timezone: "Australia/Sydney",
  timeMin: "2026-10-01T00:00:00.000Z",
  timeMax: "2026-12-30T00:00:00.000Z"
};
const calendars = [{ calendarId: CAL, summary: "Jon" }];
const MARKER = "Removed at source: ";

function event(overrides: Partial<GoogleCalendarEvent> & { externalEventId: string }): GoogleCalendarEvent {
  return {
    calendarId: CAL,
    title: "Dentist",
    description: null,
    startsAt: "2026-10-10T09:00:00.000Z",
    endsAt: "2026-10-10T10:00:00.000Z",
    allDay: false,
    timezone: "Australia/Sydney",
    location: null,
    status: "confirmed",
    seriesId: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides
  };
}
const cancelled = (e: GoogleCalendarEvent) => ({ ...e, status: "cancelled" as const });

function previewGoogle(events: GoogleCalendarEvent[]) {
  return importStore.previewGoogleCalendar({ ...window, calendars, events: events.map(toCalendarEvent) });
}
/** Previews the events and commits the batch (as the owner unless wrapped), returning the batch id; null when nothing was proposed. */
async function sync(events: GoogleCalendarEvent[], as: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()) {
  const batch = await previewGoogle(events);
  if (!batch) return null;
  await as(() => importStore.commit(batch.id, batch.version));
  return batch;
}

const asAgent = <T>(fn: () => Promise<T>) => runWithActor("claude", fn);
const asTokenAgent = <T>(fn: () => Promise<T>) => runWithActor("claude", fn, undefined, undefined, ["write:import"]);

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false, prepare: true });
  store = new NormalizedPostgresStateStore(sql);
  importStore = new PostgresImportStore(sql);
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  await store.put(createSeedState(new Date()));
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

// ---- helpers ----

type Stored = {
  id: string;
  title: string;
  status: string;
  version: number;
  closed_at: Date | null;
  closed_from_status: string | null;
  closed_by: string | null;
  closed_batch: string | null;
  closed_reason: string | null;
};
const commitmentFor = async (externalEventId: string): Promise<Stored> =>
  (
    await sql<Stored[]>`
      SELECT c.id, c.title, c.status, c.version, c.closed_at, c.closed_from_status, c.closed_by, c.closed_batch, c.closed_reason
      FROM commitments c JOIN calendar_event_links l ON l.commitment_id=c.id
      WHERE l.provider='google_calendar' AND l.external_event_id=${externalEventId}`
  )[0]!;
const linkSnapshot = async (externalEventId: string) =>
  (
    await sql<
      { last_remote_snapshot: Record<string, unknown> }[]
    >`SELECT last_remote_snapshot FROM calendar_event_links WHERE provider='google_calendar' AND external_event_id=${externalEventId}`
  )[0]!.last_remote_snapshot;
const closeRows = (entityId?: string) =>
  sql<{ write_id: string; entity_id: string; evidence: Record<string, any> }[]>`
    SELECT write_id, entity_id, evidence FROM write_rows
    WHERE operation='close' AND entity_type='commitment' ${entityId ? sql`AND entity_id=${entityId}` : sql``}
    ORDER BY created_at, entity_id`;

async function seedProject(): Promise<string> {
  const area = (
    await sql<
      { id: string }[]
    >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`
  )[0]!.id;
  const outcome = (
    await sql<
      { id: string }[]
    >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area},'Outcome','Done','active') RETURNING id`
  )[0]!.id;
  return (
    await sql<
      { id: string }[]
    >`INSERT INTO projects (outcome_id,title,status) VALUES (${outcome},'Project','active') RETURNING id`
  )[0]!.id;
}
async function seedStep(commitmentId: string, sequence: number, status = "pending"): Promise<string> {
  return (
    await sql<{ id: string }[]>`
      INSERT INTO routine_steps (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,max_lead_minutes,status)
      VALUES (${userId},${commitmentId},'commitment',${commitmentId},${"Step " + sequence},10,${sequence},'flexible',60,${status}) RETURNING id`
  )[0]!.id;
}
async function seedPrep(commitmentId: string, projectId: string, deadline = false): Promise<string> {
  const id = (
    await sql<{ id: string }[]>`
      INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes,prep_for_commitment_id)
      VALUES (${projectId},'Prep',${"one_off"},'planned',30,60,90,60,'medium',15,90,${commitmentId}) RETURNING id`
  )[0]!.id;
  if (deadline) await sql`UPDATE actions SET deadline_at = now() + interval '2 days' WHERE id=${id}`;
  return id;
}
const statusOf = async (table: "routine_steps" | "actions", id: string) =>
  (await sql<{ status: string }[]>`SELECT status::text AS status FROM ${sql(table)} WHERE id=${id}`)[0]!.status;

const closeCommand = (id: string, extra: Partial<CloseEntityCommand> = {}) =>
  ({ type: "commitment", id, verb: "cancel", do: "close", ...extra }) as CloseEntityCommand;
const restoreCommand = (id: string, expectedVersion: number) =>
  ({ type: "commitment", id, verb: "cancel", do: "restore", expectedVersion }) as CloseEntityCommand;

/** A linked event, committed. Returns the commitment. */
async function linked(e = event({ externalEventId: "e1" })) {
  await sync([e]);
  return commitmentFor(e.externalEventId);
}

// ---- cancel at the source ----

describe("a Google cancellation", () => {
  it("cancels the commitment instead of deleting it, keeping its key and link, with its steps and safe prep", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    const project = await seedProject();
    const step = await seedStep(before.id, 1);
    const blocked = await seedStep(before.id, 2, "blocked");
    const prep = await seedPrep(before.id, project);
    const dated = await seedPrep(before.id, project, true);

    const batch = await sync([cancelled(e)]);
    expect(batch!.records[0]).toMatchObject({ operation: "delete" });

    const after = await commitmentFor("e1");
    expect(after).toMatchObject({
      id: before.id,
      status: "cancelled",
      closed_by: "system",
      closed_from_status: "confirmed",
      closed_batch: batch!.id
    });
    expect(after.closed_reason).toBe(`${MARKER}Cancelled in Google Calendar`);
    expect(await sql`SELECT 1 FROM import_entity_keys WHERE entity_id=${before.id}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM calendar_event_links WHERE commitment_id=${before.id}`).toHaveLength(1);
    expect(await statusOf("routine_steps", step)).toBe("cancelled");
    expect(await statusOf("routine_steps", blocked)).toBe("cancelled");
    expect(await statusOf("actions", prep)).toBe("cancelled");
    expect(await statusOf("actions", dated)).toBe("planned");

    // one ledger row for the commitment, under the import batch's own write
    const rows = await closeRows(before.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.write_id).toBe(batch!.id);
    expect(rows[0]!.evidence).toMatchObject({
      do: "close",
      verb: "cancel",
      batch: batch!.id,
      via: "import",
      closed: 4,
      counted: false
    });
    expect(rows[0]!.evidence.skipped.map((row: { id: string }) => row.id)).toEqual([dated]);
    expect(rows[0]!.evidence.cascade).toHaveLength(3);
    // the source's removal is remembered on the link
    expect(typeof (await linkSnapshot("e1")).sourceClosed).toBe("string");

    // and the source saying it again proposes nothing, twice
    expect(await previewGoogle([cancelled(e)])).toBeNull();
    expect(await previewGoogle([cancelled(e)])).toBeNull();
    expect(await previewGoogle([])).toBeNull();
  });

  it("restores the whole import-cancelled batch through the close route, even after a replan between close and restore", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    const project = await seedProject();
    const step = await seedStep(before.id, 1);
    const prep = await seedPrep(before.id, project);
    await sync([cancelled(e)]);
    const closed = await commitmentFor("e1");
    // a replan that does not touch the cancelled steps leaves their versions alone
    await sql`UPDATE jobs SET status=status`;

    const restored = (await closeEntity(sql, restoreCommand(before.id, closed.version))).closed;
    expect(restored).toMatchObject({ status: "confirmed" });
    expect(await commitmentFor("e1")).toMatchObject({ status: "confirmed", closed_at: null, closed_batch: null });
    expect(await statusOf("routine_steps", step)).toBe("pending");
    expect(await statusOf("actions", prep)).toBe("planned");
  });

  it("is counted by the brake per commitment and per row closed with it, for an agent and not for the owner", async () => {
    const events = Array.from({ length: 7 }, (_, i) =>
      event({
        externalEventId: `e${i}`,
        title: `Event ${i}`,
        startsAt: `2026-10-1${i}T09:00:00.000Z`,
        endsAt: `2026-10-1${i}T10:00:00.000Z`
      })
    );
    await sync(events);
    for (const e of events) {
      const c = await commitmentFor(e.externalEventId);
      await seedStep(c.id, 1);
      await seedStep(c.id, 2);
    }
    // 7 commitments with 2 steps each close 21 rows: over the 20 an agent may close in an hour
    const batch = await previewGoogle(events.map(cancelled));
    expect(batch!.records).toHaveLength(7);
    await expect(asTokenAgent(() => importStore.commit(batch!.id, batch!.version))).rejects.toThrow(
      /21 closures by agents in the last hour|more than 20|closures/
    );
    expect(await sql`SELECT 1 FROM commitments WHERE status='cancelled'`).toHaveLength(0);
    // six fit (18) and are recorded as counted
    const six = await previewGoogle([...events.slice(0, 6).map(cancelled), events[6]!]);
    await asTokenAgent(() => importStore.commit(six!.id, six!.version));
    const rows = await closeRows();
    expect(rows).toHaveLength(6);
    expect(rows.every((row) => row.evidence.closed === 3 && row.evidence.counted === true)).toBe(true);
    // one more (3 rows) would make 21 in the hour
    const last = await previewGoogle(events.map(cancelled));
    expect(last!.records).toHaveLength(1);
    await expect(asTokenAgent(() => importStore.commit(last!.id, last!.version))).rejects.toThrow(
      ForbiddenCommandError
    );
    // the owner is not held to it, and what the owner closes is not counted
    await importStore.commit(last!.id, last!.version);
    expect((await closeRows()).filter((row) => row.evidence.counted === false)).toHaveLength(1);
  });

  it("writes fifty cancellations as one write with fifty ledger rows", async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      event({
        externalEventId: `m${i}`,
        title: `Meeting ${i}`,
        startsAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 1 + Math.floor(i / 28) * 3)).toISOString(),
        endsAt: new Date(Date.UTC(2026, 9, 1 + (i % 28), 2 + Math.floor(i / 28) * 3)).toISOString()
      })
    );
    await sync(events);
    const batch = await sync(events.map(cancelled));
    const rows = await closeRows();
    expect(rows).toHaveLength(50);
    expect(new Set(rows.map((row) => row.write_id))).toEqual(new Set([batch!.id]));
    expect(await sql`SELECT 1 FROM writes WHERE id=${batch!.id}`).toHaveLength(1);
  }, 120_000);

  it("leaves a running session on the commitment running, lists it, and the session can still be finished", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    const session = (
      await sql<
        { id: string }[]
      >`INSERT INTO sessions (user_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
        VALUES (${userId},'fixed_commitment',${before.id},'running',now(),now() + interval '30 minutes',now(),30,60) RETURNING id`
    )[0]!.id;

    await sync([cancelled(e)]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled" });
    const [row] = await closeRows(before.id);
    expect(row!.evidence.openSessions).toEqual([session]);
    expect(row!.evidence.dependents).toEqual([]);
    const version = (await sql<{ version: number }[]>`SELECT version FROM sessions WHERE id=${session}`)[0]!.version;
    await runActivityCommand(
      sql as never,
      {
        commandId: crypto.randomUUID(),
        expectedVersion: version,
        type: "finish_activity",
        sessionId: session,
        outcome: "completed"
      } as never
    );
    expect((await sql<{ status: string }[]>`SELECT status FROM sessions WHERE id=${session}`)[0]!.status).not.toBe(
      "running"
    );
  }, 30_000);

  it("leaves a prep action somebody is working on open and lists it", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    const project = await seedProject();
    const busyPrep = await seedPrep(before.id, project);
    const freePrep = await seedPrep(before.id, project);
    await sql`INSERT INTO sessions (user_id,action_id,target_type,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${userId},${busyPrep},'action','running',now(),now() + interval '30 minutes',now(),30,60)`;
    await sync([cancelled(e)]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled" });
    expect(await statusOf("actions", busyPrep)).toBe("planned");
    expect(await statusOf("actions", freePrep)).toBe("cancelled");
    const [row] = await closeRows(before.id);
    expect(row!.evidence.skipped.map((s: { id: string }) => s.id)).toEqual([busyPrep]);
    expect(row!.evidence.closed).toBe(2);
  });
});

// ---- a cancel the person made ----

describe("a commitment the person cancelled", () => {
  it("stays cancelled, closed by the person, however many times the same event is imported", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    await closeEntity(sql, closeCommand(before.id));
    const mine = await commitmentFor("e1");
    expect(mine).toMatchObject({ status: "cancelled", closed_by: "person" });

    // regression guard: an unchanged re-import proposes nothing, twice
    expect(await previewGoogle([e])).toBeNull();
    expect(await previewGoogle([e])).toBeNull();
    // and the source cancelling the event does not turn into a delete or a rewrite of the person's close
    expect(await previewGoogle([cancelled(e)])).toBeNull();
    expect(await previewGoogle([])).toBeNull();
    expect(await commitmentFor("e1")).toEqual(mine);
  });

  it("is not reopened by a changed event, which is proposed with the 'still cancelled by you' warning", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    await closeEntity(sql, closeCommand(before.id));
    const batch = await previewGoogle([{ ...e, title: "Dentist (moved)" }]);
    expect(batch!.records[0]).toMatchObject({ operation: "update" });
    expect(batch!.records[0]!.warnings).toContain("Still cancelled by you. Restore it from Review > Closed.");
    await importStore.commit(batch!.id, batch!.version);
    expect(await commitmentFor("e1")).toMatchObject({
      title: "Dentist (moved)",
      status: "cancelled",
      closed_by: "person"
    });
  });

  it("is not reopened when a conflict is resolved to the source's version, or a CSV import writes it confirmed", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    await closeEntity(sql, closeCommand(before.id));
    const stored = await commitmentFor("e1");
    // the importer's own write of `confirmed` over a closed row: the status guard keeps it cancelled
    const { parseImportCsv } = await import("@/features/imports/import-csv");
    const csv = await importStore.preview({
      sourceType: "csv",
      inputKind: "capacity_commitments",
      timezone: "Australia/Sydney",
      templateVersion: "1",
      records: parseImportCsv(
        "fixed_commitments",
        `import_key,title,starts_at,ends_at,status,setup_before_minutes,transition_after_minutes\r\ngoogle_calendar:event:${CAL}:e1,Dentist,2026-10-10T09:00:00.000Z,2026-10-10T10:00:00.000Z,confirmed,0,0`
      ),
      source: {}
    });
    expect(csv.records[0]).toMatchObject({ operation: "update", matchedEntityId: before.id });
    await importStore.commit(csv.id, csv.version);
    expect(await commitmentFor("e1")).toMatchObject({
      status: "cancelled",
      closed_by: "person",
      closed_batch: stored.closed_batch
    });
  });

  it("is left alone by a close from the source: nothing is rewritten, nothing is counted", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    await closeEntity(sql, closeCommand(before.id, { reason: "Not going" }));
    const mine = await commitmentFor("e1");
    const ledger = (await closeRows()).length;
    const result = await sql.begin((tx) =>
      closeCommitmentAsSystem(tx as never, { userId, id: before.id, why: "Cancelled in Google Calendar" })
    );
    expect(result).toEqual({ closed: false, rows: 0 });
    expect(await commitmentFor("e1")).toEqual(mine);
    expect(await closeRows()).toHaveLength(ledger);
  });
});

// ---- an event that comes back ----

describe("an event that returns after a cancellation", () => {
  it("reopens the commitment with its original status when nothing about it changed, and its steps come back", async () => {
    const e = event({ externalEventId: "e1" });
    await sync([e]);
    await sql`UPDATE commitments SET status='tentative' WHERE title='Dentist'`;
    const before = await commitmentFor("e1");
    const step = await seedStep(before.id, 1);
    await sync([cancelled(e)]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled", closed_from_status: "tentative" });
    expect(await statusOf("routine_steps", step)).toBe("cancelled");

    const back = await previewGoogle([e]);
    expect(back!.records).toHaveLength(1);
    expect(back!.records[0]).toMatchObject({ operation: "update", relationships: { sourceReopen: "true" } });
    await importStore.commit(back!.id, back!.version);
    expect(await commitmentFor("e1")).toMatchObject({
      status: "tentative",
      closed_at: null,
      closed_by: null,
      closed_batch: null,
      closed_reason: null
    });
    expect(await statusOf("routine_steps", step)).toBe("pending");
    expect((await linkSnapshot("e1")).sourceClosed).toBeUndefined();
    // steady afterwards
    expect(await previewGoogle([e])).toBeNull();
  });

  it("cancels it again when the source cancels it again (a re-cancel after an un-cancel works)", async () => {
    const e = event({ externalEventId: "e1" });
    await linked(e);
    await sync([cancelled(e)]);
    await sync([e]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "confirmed" });
    await sync([cancelled(e)]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled", closed_by: "system" });
    expect(await closeRows()).toHaveLength(2);
  });

  it("also reopens one that was merely missing from the read, and cancels it again when it goes missing again", async () => {
    const e = event({ externalEventId: "e1" });
    await linked(e);
    const gone = await sync([]);
    expect(gone!.records[0]).toMatchObject({ operation: "delete" });
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled" });
    await sync([e]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "confirmed" });
    await sync([]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled" });
  });

  it("keeps a person's restore while the source stays cancelled, and cancels again after the source un-cancels and re-cancels", async () => {
    const e = event({ externalEventId: "e1" });
    await linked(e);
    await sync([cancelled(e)]);
    const closed = await commitmentFor("e1");
    await closeEntity(sql, restoreCommand(closed.id, closed.version));
    expect(await commitmentFor("e1")).toMatchObject({ status: "confirmed" });
    // two syncs with the event still cancelled, or missing: the restore sticks
    expect(await previewGoogle([cancelled(e)])).toBeNull();
    expect(await previewGoogle([cancelled(e)])).toBeNull();
    expect(await previewGoogle([])).toBeNull();
    expect(await commitmentFor("e1")).toMatchObject({ status: "confirmed" });
    // the source un-cancels: the memory of its removal is cleared, though nothing about the commitment changes
    const back = await previewGoogle([e]);
    expect(back!.records[0]).toMatchObject({ relationships: { sourceClear: "true" } });
    await importStore.commit(back!.id, back!.version);
    expect((await linkSnapshot("e1")).sourceClosed).toBeUndefined();
    expect(await previewGoogle([e])).toBeNull();
    // and then cancels again: that counts
    await sync([cancelled(e)]);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled", closed_by: "system" });
  });

  it("never reopens what a person or an agent cancelled, however the event returns", async () => {
    const e = event({ externalEventId: "e1" });
    const before = await linked(e);
    await asAgent(() => closeEntity(sql, closeCommand(before.id, { reason: "Declined" })));
    const byAgent = await commitmentFor("e1");
    expect(byAgent.closed_by).toBe("agent:claude");
    expect(await previewGoogle([e])).toBeNull();
    const changed = await previewGoogle([{ ...e, title: "Dentist 2" }]);
    await importStore.commit(changed!.id, changed!.version);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled", closed_by: "agent:claude" });
  });

  it("is refused to an agent's commit as a reopen, and applied by the owner", async () => {
    const e = event({ externalEventId: "e1" });
    await linked(e);
    await sync([cancelled(e)]);
    const back = await previewGoogle([e]);
    await expect(asAgent(() => importStore.commit(back!.id, back!.version))).rejects.toThrow(ForbiddenCommandError);
    expect(await commitmentFor("e1")).toMatchObject({ status: "cancelled" });
    await importStore.commit(back!.id, back!.version);
    expect(await commitmentFor("e1")).toMatchObject({ status: "confirmed" });
  });
});
