import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { reenterCommandSchema, type ReenterCommand } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { ensureUser } from "./ensure-user";
import { readCatchUpLedger, settleCatchUp } from "./catch-up";
import { CommandConflictError } from "./command-errors";
import { ReentryIncompleteError, readPulseReentryView, reenter } from "./reenter";
import { runRevertCommand } from "./write-revert";
import { runPulseRecorderTick } from "@/server/pulse/pulse-recorder";
import { reentryGate } from "@/server/pulse/reentry-gate";
import { waitUntilBlocked } from "./wait-until-blocked";

/**
 * Re-entry: the tiered ledger from the pulse window, the all-or-nothing
 * rejection, the settle that never writes `done` for what nobody confirmed, the lapsed pulse ending, and the one
 * undo that puts the pulse and the items back.
 */
config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "rhen_reenter");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

const NOW = new Date("2026-10-28T02:00:00Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);
const daysAgo = (days: number) => hoursAgo(days * 24);

async function createProject(title: string, dates: { internal?: Date; external?: Date } = {}) {
  const area = await sql<
    { id: string }[]
  >`INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},${"Area " + crypto.randomUUID()},'active',0) RETURNING id`;
  const outcome = await sql<
    { id: string }[]
  >`INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id`;
  const project = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id,title,status,internal_deadline_at,external_deadline_at)
    VALUES (${outcome[0]!.id},${title},'active',${dates.internal ?? null},${dates.external ?? null}) RETURNING id`;
  return project[0]!.id;
}

async function createOccurrence(projectId: string, endedAt: Date): Promise<string> {
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${projectId},'Stretch','recurring','active',5,10,15,10,'low',5,15) RETURNING id`;
  const rule = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_rules (action_id,timezone,start_date,interval_days,completion_mode)
    VALUES (${action[0]!.id},'UTC','2026-01-01',1,'manual') RETURNING id`;
  const window = await sql<{ id: string }[]>`
    INSERT INTO action_recurrence_windows (rule_id,name,anchor,local_start_time,local_end_time)
    VALUES (${rule[0]!.id},'Day','local_time','08:00','20:00') RETURNING id`;
  const id = `occ-${crypto.randomUUID()}`;
  await sql`
    INSERT INTO action_occurrences (id,action_id,rule_id,window_id,local_date,window_starts_at,window_ends_at,anchor_source)
    VALUES (${id},${action[0]!.id},${rule[0]!.id},${window[0]!.id},${endedAt.toISOString().slice(0, 10)},${new Date(endedAt.getTime() - 3_600_000)},${endedAt},'local_time')`;
  return id;
}

/** The lapsed pulse: the open segment is `off/lapsed`, last confirmed `confirmedAgo` hours before NOW. */
async function lapse(confirmedHoursAgo: number) {
  await sql`DELETE FROM pulse_segments WHERE user_id=${userId}`;
  await sql`INSERT INTO pulse_segments (user_id, started_at, ended_at, state, reason, confirmed_at)
    VALUES (${userId}, ${hoursAgo(confirmedHoursAgo + 1)}, ${hoursAgo(confirmedHoursAgo)}, 'on', 'confirmed', ${hoursAgo(confirmedHoursAgo)})`;
  await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at)
    VALUES (${userId}, ${hoursAgo(confirmedHoursAgo)}, 'off', 'lapsed', ${hoursAgo(confirmedHoursAgo)})`;
}

async function savedPlaces() {
  await sql`INSERT INTO condition_definitions (user_id,id,name,kind) VALUES (${userId},'home','Home','location'),(${userId},'campus','Campus','location'),(${userId},'laptop','Laptop','capability') ON CONFLICT DO NOTHING`;
}

const FACTS = { locationId: "home", energy: "medium", contexts: ["laptop"] } as const;
function command(overrides: Partial<ReenterCommand> = {}): ReenterCommand {
  return reenterCommandSchema.parse({ commandId: crypto.randomUUID(), ...FACTS, ...overrides });
}

/** What an agent must send with the three facts: the owner said them, in their own words. */
const STATED = { basis: "stated", evidence: "The owner said so in the chat." } as const;
const asAgent = <T>(fn: () => Promise<T>) => runWithActor("companion", fn);
const openSegment = async () =>
  (
    await sql<
      { state: string; reason: string | null; started_at: Date; confirmed_at: Date | null }[]
    >`SELECT state, reason, started_at, confirmed_at FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL`
  )[0];
const occurrenceStatus = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM action_occurrences WHERE id=${id}`)[0]!.status;
const projectRow = async (id: string) =>
  (
    await sql<
      { status: string; internal_deadline_at: Date | null }[]
    >`SELECT status, internal_deadline_at FROM projects WHERE id=${id}`
  )[0]!;

/** The three right-now entries a re-entry leaves on the ledger: a stale wake, an open check-in and an open session. */
async function createRightNowEntries(): Promise<string[]> {
  const project = await createProject("Thesis");
  const action = await sql<{ id: string }[]>`
    INSERT INTO actions (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
    VALUES (${project},'Draft citations','one_off','doing',30,60,90,60,'medium',15,90) RETURNING id`;
  const sessionId = crypto.randomUUID();
  const startedAt = hoursAgo(5);
  await sql`
    INSERT INTO sessions (id,user_id,action_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
    VALUES (${sessionId},${userId},${action[0]!.id},'running',${startedAt},${new Date(startedAt.getTime() + 3_600_000)},${startedAt},60,60)`;
  await sql`INSERT INTO session_segments (session_id,started_at) VALUES (${sessionId},${startedAt})`;
  const checkIn = await sql<{ id: string }[]>`
    INSERT INTO check_in (user_id,slot_at,directive_kind,directive_title,status) VALUES (${userId},${hoursAgo(2)},'action','Draft citations','unknown') RETURNING id`;
  await sql`UPDATE user_preferences SET last_woke_at=${hoursAgo(30)} WHERE user_id=${userId}`;
  return ["wake", `check-in:${checkIn[0]!.id}`, `session:${sessionId}`];
}
const ledgerIds = async () =>
  (await readCatchUpLedger(sql as never, { now: NOW })).entries.map((entry) => entry.id).sort();
const reenterWrites = async () =>
  (await sql`SELECT 1 FROM writes WHERE user_id=${userId} AND command_type='reenter'`).length;

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE writes, write_rows, catch_up_runs, check_in, session_segments, sessions, action_occurrences, action_recurrence_windows, action_recurrence_rules, actions, projects, outcomes, areas, plan_map_switches, push_outbox, pulse_segments, pulse_state, condition_definitions RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET last_woke_at=NULL, max_awake_hours=18 WHERE user_id=${userId}`;
  await savedPlaces();
});

afterAll(async () => {
  await sql?.end();
});

describe("the ledger from the pulse window", () => {
  it("is due the moment the pulse lapses, with no tier block while the pulse is on", async () => {
    await createProject("Lapsed", { internal: hoursAgo(1) });
    await sql`INSERT INTO catch_up_runs (user_id, window_since, window_until, closed_at, closed_by, counts) VALUES (${userId}, ${hoursAgo(9)}, ${hoursAgo(1)}, ${hoursAgo(1)}, 'x', '{}')`;
    const before = await readCatchUpLedger(sql as never, { now: NOW });
    expect(before.due).toBe(false);
    expect(before.reentry).toBeUndefined();
    await lapse(1);
    const ledger = await readCatchUpLedger(sql as never, { now: NOW });
    expect(ledger.due).toBe(true);
    expect(ledger.reentry).toMatchObject({ tier: "none", gapMinutes: 60 });
  });

  it("keeps the 36 hour rule as a fallback when the pulse never lapsed", async () => {
    await createProject("Stale", { internal: daysAgo(3) });
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at)
      VALUES (${userId}, ${daysAgo(3)}, 'on', 'confirmed', ${daysAgo(3)})`;
    await sql`INSERT INTO catch_up_runs (user_id, window_since, window_until, closed_at, closed_by, counts) VALUES (${userId}, ${daysAgo(9)}, ${daysAgo(2)}, ${daysAgo(2)}, 'x', '{}')`;
    const ledger = await readCatchUpLedger(sql as never, { now: NOW });
    expect(ledger.due).toBe(true);
    expect(ledger.reentry).toBeUndefined();
  });

  it.each([
    [1, "none"],
    [5, "today"],
    [50, "days"],
    [24 * 9, "projects"]
  ])("a gap of %s hours reviews as %s and groups what the tier groups by", async (hours, tier) => {
    const first = await createProject("First", { internal: hoursAgo(hours - 0.5) });
    const second = await createProject("Second", { internal: hoursAgo(hours - 0.25) });
    await createOccurrence(first, hoursAgo(hours - 0.5));
    await lapse(hours);
    const ledger = await readCatchUpLedger(sql as never, { now: NOW });
    expect(ledger.reentry?.tier).toBe(tier);
    expect(ledger.reentry?.reviewable).toBe(2);
    expect(ledger.reentry?.lapsing).toBe(1);
    expect(ledger.reentry?.days.length).toBe(tier === "days" || tier === "projects" ? 1 : 0);
    expect(ledger.reentry?.projects.map((project) => project.projectId).sort()).toEqual(
      tier === "projects" ? [first, second].sort() : []
    );
  });

  it("leaves out what lapsed before the window opened", async () => {
    await createProject("Older", { internal: daysAgo(20) });
    await createProject("Inside", { internal: hoursAgo(2) });
    await lapse(5);
    const ledger = await readCatchUpLedger(sql as never, { now: NOW });
    expect(ledger.unsettled).toBe(2);
    expect(ledger.reentry?.reviewable).toBe(1);
  });
});

describe("a pulse that never started", () => {
  const neverConfirmed = async () => {
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason) VALUES (${userId}, ${hoursAgo(5)}, 'off', 'lapsed')`;
    await sql`INSERT INTO pulse_state (user_id, last_contact_at, last_contact_source) VALUES (${userId}, ${hoursAgo(1)}, 'person')`;
  };

  it("is not lapsed and demands no re-entry while nothing was ever confirmed", async () => {
    await neverConfirmed();
    const read = await readPulseReentryView(sql as never, NOW);
    expect(read?.lapsed).toBe(false);
    expect(read?.view.reentry).toMatchObject({ due: false, missing: [] });
  });

  it("gates exactly as before once any confirmation exists", async () => {
    await neverConfirmed();
    await lapse(30);
    const read = await readPulseReentryView(sql as never, NOW);
    expect(read?.lapsed).toBe(true);
    expect(read?.view.reentry.due).toBe(true);
  });

  it("counts a confirmation remembered only in the pulse memory as history", async () => {
    await neverConfirmed();
    await sql`UPDATE pulse_state SET last_confirmed_at=${hoursAgo(30)} WHERE user_id=${userId}`;
    expect((await readPulseReentryView(sql as never, NOW))?.lapsed).toBe(true);
  });
});

describe("reenter", () => {
  it("is refused when nothing is lapsed", async () => {
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at) VALUES (${userId}, ${hoursAgo(1)}, 'on', 'confirmed', ${hoursAgo(1)})`;
    await expect(reenter(sql as never, command(), NOW)).rejects.toBeInstanceOf(CommandConflictError);
  });

  it("rejects an incomplete answer naming each missing fact and unreviewed item, and writes nothing", async () => {
    const stale = await createProject("Lab report", { internal: hoursAgo(3) });
    const occurrence = await createOccurrence(stale, hoursAgo(3));
    await lapse(5);
    const incomplete = reenterCommandSchema.parse({ commandId: crypto.randomUUID(), locationId: "home" });
    const error = await reenter(sql as never, incomplete, NOW).catch((caught) => caught);
    expect(error).toBeInstanceOf(ReentryIncompleteError);
    expect((error as ReentryIncompleteError).body.missing).toEqual([
      "energy",
      "contexts",
      `review deadline:${stale} "Lab report" (planned ${hoursAgo(3).toISOString().slice(0, 10)})`
    ]);
    expect((error as Error).message).toContain("nothing was written");
    // The refusal carries what is still to settle, since every read is held while the pulse is lapsed.
    const body = (error as ReentryIncompleteError).body;
    expect(body).toMatchObject({ tier: "today", gapMinutes: expect.any(Number) });
    expect(body.review.entries).toEqual([expect.objectContaining({ id: `deadline:${stale}`, title: "Lab report" })]);
    expect(body.choices).toEqual({ places: expect.any(Array), contexts: expect.any(Array) });
    expect((await openSegment())?.reason).toBe("lapsed");
    expect(await occurrenceStatus(occurrence)).toBe("pending");
    expect((await sql`SELECT 1 FROM writes WHERE user_id=${userId} AND command_type='reenter'`).length).toBe(0);
  });

  it("settles a today-tier gap: confirmed answers apply, occurrences lapse as missed, nothing is marked done unasked", async () => {
    const lab = await createProject("Lab report", { internal: hoursAgo(3) });
    const exam = await createProject("Exam prep", { internal: hoursAgo(4) });
    const occurrence = await createOccurrence(lab, hoursAgo(3));
    await lapse(6);
    const done = await asAgent(() =>
      reenter(
        sql as never,
        command({
          ...STATED,
          settlement: {
            items: [
              { entryId: `deadline:${lab}`, verdict: "done", at: hoursAgo(3).toISOString() },
              { entryId: `deadline:${exam}`, verdict: "pending" }
            ]
          }
        }),
        NOW
      )
    );
    expect(done).toMatchObject({ reentered: true, tier: "today", confirmedBy: "agent", lapsed: 1, unrecorded: 1 });
    expect(await occurrenceStatus(occurrence)).toBe("missed");
    expect((await projectRow(lab)).status).toBe("done");
    expect((await projectRow(exam)).status).toBe("active");
    // Nothing a bulk answer wrote is a session outcome, so duration and pace learning (which read finished
    // sessions) see nothing from the gap.
    expect((await sql`SELECT 1 FROM sessions WHERE user_id=${userId}`).length).toBe(0);

    const segment = await openSegment();
    expect(segment).toMatchObject({ state: "on", reason: "reentered" });
    expect(segment?.confirmed_at?.toISOString()).toBe(NOW.toISOString());
    expect(
      (await sql`SELECT 1 FROM pulse_segments WHERE user_id=${userId} AND state='off' AND ended_at=${NOW}`).length
    ).toBe(1);

    const prefs = await sql<
      { current_energy: string; current_situation: { locationId: string; overrides: Record<string, string> } }[]
    >`SELECT current_energy, current_situation FROM user_preferences WHERE user_id=${userId}`;
    expect(prefs[0]?.current_energy).toBe("medium");
    expect(prefs[0]?.current_situation.locationId).toBe("home");
    expect(prefs[0]?.current_situation.overrides).toEqual({ laptop: "available" });

    const logged = await sql<
      { evidence: { unrecordedEntries: string[]; confirmedBy: string; tier: string } }[]
    >`SELECT evidence FROM write_rows WHERE user_id=${userId} AND operation='reenter'`;
    expect(logged).toHaveLength(1);
    expect(logged[0]?.evidence).toMatchObject({ confirmedBy: "agent", tier: "today" });
    expect(logged[0]?.evidence.unrecordedEntries).toEqual([`occurrence:${occurrence}`]);
  });

  it("a day tap at the days tier writes skipped for its occurrences and carries its dates, never done", async () => {
    const project = await createProject("Habits", { internal: hoursAgo(30) });
    const occurrence = await createOccurrence(project, hoursAgo(30));
    await lapse(50);
    const day = (await readCatchUpLedger(sql as never, { now: NOW })).reentry!.days[0]!.day;
    const result = await reenter(
      sql as never,
      command({ settlement: { days: [{ day, answer: "nothing_recorded" }] } }),
      NOW
    );
    expect(result).toMatchObject({ tier: "days", confirmedBy: "person" });
    expect(await occurrenceStatus(occurrence)).toBe("missed");
    const completed = await sql`SELECT 1 FROM action_occurrences WHERE completed_at IS NOT NULL`;
    expect(completed).toHaveLength(0);
    expect((await projectRow(project)).internal_deadline_at).not.toBeNull();
  });

  it("start fresh after a long gap clears lapsed own dates but cannot cover an external date", async () => {
    const own = await createProject("Own date", { internal: daysAgo(8) });
    const external = await createProject("Due to others", { external: daysAgo(8) });
    await lapse(24 * 9);
    const refused = await reenter(sql as never, command({ settlement: { startFresh: true } }), NOW).catch((e) => e);
    expect(refused).toBeInstanceOf(ReentryIncompleteError);
    expect((refused as ReentryIncompleteError).body.missing).toEqual([expect.stringContaining(`deadline:${external}`)]);
    const done = await reenter(
      sql as never,
      command({ settlement: { startFresh: true, items: [{ entryId: `deadline:${external}`, verdict: "pending" }] } }),
      NOW
    );
    expect(done.tier).toBe("projects");
    expect((await projectRow(own)).internal_deadline_at).toBeNull();
  });

  it("rejects an unknown place or context without writing", async () => {
    await lapse(1);
    await expect(reenter(sql as never, command({ locationId: "nowhere" }), NOW)).rejects.toThrow(/location/i);
    await expect(reenter(sql as never, command({ contexts: ["jetpack"] }), NOW)).rejects.toThrow(
      /Not an active context/
    );
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("answers a repeated command id with the first result", async () => {
    await lapse(1);
    const cmd = command();
    const first = await reenter(sql as never, cmd, NOW);
    const second = await reenter(sql as never, cmd, new Date(NOW.getTime() + 60_000));
    expect(second).toEqual(first);
    expect((await sql`SELECT 1 FROM pulse_segments WHERE user_id=${userId} AND reason='reentered'`).length).toBe(1);
  });

  it("is one undoable entry: undo puts the lapsed pulse and the unsettled items back, redo re-enters", async () => {
    const lab = await createProject("Lab report", { internal: hoursAgo(3) });
    const occurrence = await createOccurrence(lab, hoursAgo(3));
    await lapse(6);
    // What a re-entry moves besides the segment: the situation facts and the recorder's memory of the lapse.
    await sql`UPDATE user_preferences SET current_energy='high', asserted_conditions='["old-context"]'::jsonb WHERE user_id=${userId}`;
    await sql`INSERT INTO pulse_state (user_id, last_confirmed_at, confirmed_by, last_contact_at, last_contact_source, entered_lapsed_at, unanswered_prompts, unknown_minutes)
      VALUES (${userId}, ${hoursAgo(6)}, 'person', ${hoursAgo(6)}, 'person', ${hoursAgo(5)}, 2, 40)`;
    const memory = async () =>
      (
        await sql<
          Record<string, unknown>[]
        >`SELECT last_confirmed_at, confirmed_by, last_contact_at, entered_lapsed_at, unanswered_prompts, unknown_minutes FROM pulse_state WHERE user_id=${userId}`
      )[0];
    const facts = async () =>
      (
        await sql<
          Record<string, unknown>[]
        >`SELECT current_energy, asserted_conditions FROM user_preferences WHERE user_id=${userId}`
      )[0];
    const memoryBefore = await memory();
    const factsBefore = await facts();
    const cmd = command({ ...STATED, settlement: { items: [{ entryId: `deadline:${lab}`, verdict: "done" }] } });
    await asAgent(() => reenter(sql as never, cmd, NOW));
    expect((await openSegment())?.reason).toBe("reentered");
    expect(await facts()).not.toEqual(factsBefore);
    expect((await memory())?.entered_lapsed_at).toBeNull();

    const revert = (direction: "undo" | "redo") =>
      asAgent(() =>
        runRevertCommand(sql as never, { commandId: crypto.randomUUID(), target: cmd.commandId, direction } as never)
      );
    await revert("undo");
    expect(await occurrenceStatus(occurrence)).toBe("pending");
    expect((await projectRow(lab)).status).toBe("active");
    const lapsed = await openSegment();
    expect(lapsed).toMatchObject({ state: "off", reason: "lapsed" });
    expect((await sql`SELECT 1 FROM pulse_segments WHERE user_id=${userId} AND reason='reentered'`).length).toBe(0);
    // The gate holds again, and the facts and the recorder's memory of the lapse are what they were.
    expect((await readPulseReentryView(sql as never, NOW))?.lapsed).toBe(true);
    expect(await facts()).toEqual(factsBefore);
    expect(await memory()).toEqual(memoryBefore);

    await revert("redo");
    expect((await openSegment())?.reason).toBe("reentered");
    expect(await occurrenceStatus(occurrence)).toBe("missed");
  });

  it("serialises with a recorder tick: a tick racing the re-entry neither re-lapses the pulse nor opens a second segment", async () => {
    // The recorder reads arrays, which the shared connection (no type fetch) cannot.
    const recorderSql = postgres(testUrl.toString(), { max: 3, connect_timeout: 10 });
    try {
      for (let round = 0; round < 6; round += 1) {
        await lapse(6);
        const cmd = command();
        const settled = await Promise.allSettled([
          runPulseRecorderTick(recorderSql as never, NOW),
          reenter(sql as never, cmd, NOW),
          runPulseRecorderTick(recorderSql as never, NOW)
        ]);
        expect(
          settled.map((result) => result.status),
          `round ${round}`
        ).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
        const open = await sql`SELECT state, reason FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL`;
        expect(open.length, `round ${round}`).toBe(1);
        // A tick after the re-entry may move the pulse on (to `free`, with nothing planned); it must never lapse it again.
        expect(open[0]).not.toMatchObject({ state: "off" });
      }
    } finally {
      await recorderSql.end();
    }
  });

  it("waits for the recorder's per-user lock before it reads the pulse", async () => {
    await lapse(6);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // A recorder pass in flight: it holds the advisory lock for the length of its transaction.
    const tick = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`pulse_recorder:${userId}`}, 0))`;
      locked();
      await held;
    });
    await lockTaken;
    let finished = false;
    const done = reenter(sql as never, command(), NOW).then(() => (finished = true));
    await waitUntilBlocked(sql);
    expect(finished).toBe(false);
    release();
    await tick;
    await done;
    expect(finished).toBe(true);
    expect((await openSegment())?.reason).toBe("reentered");
  });

  it("refuses the undo once the new segment has moved on, rather than overwriting it", async () => {
    await lapse(1);
    const cmd = command(STATED);
    await asAgent(() => reenter(sql as never, cmd, NOW));
    // The pulse changed state after re-entry (a later check-in, a new lapse): that is not this write's to undo.
    await sql`UPDATE pulse_segments SET ended_at=${new Date(NOW.getTime() + 600_000)} WHERE user_id=${userId} AND reason='reentered'`;
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason) VALUES (${userId}, ${new Date(NOW.getTime() + 600_000)}, 'on', 'confirmed')`;
    const refused = await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" } as never
      )
    ).catch((caught) => caught);
    expect(refused).toBeInstanceOf(CommandConflictError);
    // F22: the refusal says why and what to do instead, not just "changed".
    expect((refused as Error).message).toContain("pulse has moved on");
    expect((refused as Error).message).toContain("rhen_reenter cannot be used again while the pulse is on");
    expect((refused as Error).message).toContain("rhen_arrive");
  });

  it("undoes a re-entry after the recorder's next tick ended the reentered segment (#768)", async () => {
    await lapse(1);
    const cmd = command(STATED);
    await asAgent(() => reenter(sql as never, cmd, NOW));
    // The recorder reads arrays, which the shared connection (no type fetch) cannot.
    const recorderSql = postgres(testUrl.toString(), { max: 3, connect_timeout: 10 });
    try {
      await runPulseRecorderTick(recorderSql as never, new Date(NOW.getTime() + 1_000));
    } finally {
      await recorderSql.end();
    }
    // The tick moved the pulse on: the reentered segment is closed and a recorder-made one is open.
    expect(
      (await sql`SELECT 1 FROM pulse_segments WHERE user_id=${userId} AND reason='reentered' AND ended_at IS NOT NULL`)
        .length
    ).toBe(1);
    expect((await openSegment())?.reason).not.toBe("reentered");
    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" } as never
      )
    );
    expect(await openSegment()).toMatchObject({ state: "off", reason: "lapsed" });
    expect(
      (await sql`SELECT 1 FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL`).length,
      "exactly one open segment"
    ).toBe(1);
    expect((await sql`SELECT 1 FROM pulse_segments WHERE user_id=${userId} AND reason='reentered'`).length).toBe(0);
    // Redo re-enters again, with one open segment.
    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "redo" } as never
      )
    );
    expect((await openSegment())?.reason).toBe("reentered");
  });

  it("still refuses the undo when a later segment carries real contact (a check-in or session)", async () => {
    await lapse(1);
    const cmd = command(STATED);
    await asAgent(() => reenter(sql as never, cmd, NOW));
    const at = new Date(NOW.getTime() + 600_000);
    await sql`UPDATE pulse_segments SET ended_at=${at} WHERE user_id=${userId} AND reason='reentered'`;
    await sql`INSERT INTO pulse_segments (user_id, started_at, ended_at, state, reason) VALUES (${userId}, ${at}, ${new Date(at.getTime() + 1_000)}, 'free', 'free')`;
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at) VALUES (${userId}, ${new Date(at.getTime() + 1_000)}, 'on', 'confirmed', ${at})`;
    const refused = await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" } as never
      )
    ).catch((caught) => caught);
    expect(refused).toBeInstanceOf(CommandConflictError);
    expect((await openSegment())?.reason).toBe("confirmed");
  });

  it("lets the recorder's own contact bookkeeping on pulse_state stand without refusing the undo (F22)", async () => {
    await lapse(1);
    const cmd = command(STATED);
    await asAgent(() => reenter(sql as never, cmd, NOW));
    // What the next recorder pass does within seconds: it re-reads the latest contact from the write log, which
    // includes the re-entry's own row, a few milliseconds after the `at` the re-entry used.
    await sql`UPDATE pulse_state SET last_contact_at=${new Date(NOW.getTime() + 40)}, last_contact_source='agent', last_evaluated_at=${new Date(NOW.getTime() + 5_000)} WHERE user_id=${userId}`;
    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" } as never
      )
    );
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("lets the recorder's own churn on the open segment (target, confirmation) stand without refusing the undo", async () => {
    await lapse(1);
    const cmd = command(STATED);
    await asAgent(() => reenter(sql as never, cmd, NOW));
    await sql`UPDATE pulse_segments SET doing_kind='action', doing_id='a1', doing_title='Reading', confirmed_at=${new Date(NOW.getTime() + 300_000)} WHERE user_id=${userId} AND ended_at IS NULL`;
    await asAgent(() =>
      runRevertCommand(
        sql as never,
        { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" } as never
      )
    );
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("works for the person too: their re-entry is snapshotted and the owner can undo it", async () => {
    await lapse(1);
    const cmd = command();
    const result = await reenter(sql as never, cmd, NOW);
    expect(result.confirmedBy).toBe("person");
    await runRevertCommand(
      sql as never,
      { commandId: crypto.randomUUID(), target: cmd.commandId, direction: "undo" } as never
    );
    expect((await openSegment())?.reason).toBe("lapsed");
  });
});

describe("re-entry leaves the right-now entries on the ledger", () => {
  it.each([
    [50, "days"],
    [24 * 9, "projects"]
  ])(
    "re-enters a %s hour gap holding a stale wake, an open check-in and an open session, and settles none of them",
    async (hours, tier) => {
      const open = await createRightNowEntries();
      await lapse(hours);
      expect(await ledgerIds()).toEqual([...open].sort());
      const result = await reenter(sql as never, command(), NOW);
      expect(result).toMatchObject({ reentered: true, tier });
      expect([...(result.leftOnLedger ?? [])].sort()).toEqual([...open].sort());
      expect(result.next).toContain("rhen_catch_up");
      expect(result.next).toContain("rhen_catch_up_settle");
      expect(result.next).toContain("rhen_wake");
      for (const id of open) expect(result.next).toContain(id);
      expect(await openSegment()).toMatchObject({ state: "on", reason: "reentered" });
      expect(await ledgerIds()).toEqual([...open].sort());
    }
  );

  it.each([[0], [1], [2]])(
    "refuses naming entry %#, pointing at catch-up-settle, and writes nothing",
    async (index) => {
      const open = await createRightNowEntries();
      await lapse(50);
      const named = [...open].sort()[index]!;
      const error = await reenter(
        sql as never,
        command({ settlement: { items: [{ entryId: named, verdict: "pending" }] } }),
        NOW
      ).catch((caught) => caught);
      expect(error).toBeInstanceOf(ReentryIncompleteError);
      expect((error as Error).message).toContain("catch-up-settle");
      expect((error as Error).message).toContain(named);
      expect((await openSegment())?.reason).toBe("lapsed");
      expect(await reenterWrites()).toBe(0);
      expect(await ledgerIds()).toEqual([...open].sort());
    }
  );
});

describe("the owner-only bulk resets", () => {
  const ownerOnly = /only the owner can choose it/;

  it("refuses an agent's inferred startFresh and drop_all, writing nothing, and lets a stated one through", async () => {
    const project = await createProject("Old project");
    await lapse(24 * 9);
    const cases = [
      command({ settlement: { startFresh: true } }),
      command({ settlement: { projects: [{ projectId: project, answer: "drop_all" }] } })
    ];
    for (const refusedCommand of cases) {
      const error = await asAgent(() => reenter(sql as never, refusedCommand, NOW)).catch((caught) => caught);
      expect(error).toBeInstanceOf(ReentryIncompleteError);
      expect((error as Error).message).toMatch(ownerOnly);
      expect((await openSegment())?.reason).toBe("lapsed");
      expect(await reenterWrites()).toBe(0);
    }
    for (const stated of [
      command({ settlement: { startFresh: true }, basis: "stated", evidence: "Owner: start fresh" }),
      command({
        settlement: { projects: [{ projectId: project, answer: "drop_all" }] },
        basis: "stated",
        evidence: "Owner: drop the old project"
      })
    ]) {
      await lapse(24 * 9);
      const result = await asAgent(() => reenter(sql as never, stated, NOW));
      expect(result).toMatchObject({ reentered: true, tier: "projects", confirmedBy: "agent" });
      expect((await openSegment())?.reason).toBe("reentered");
    }
  });

  it("never blocks a person, whatever the basis", async () => {
    const project = await createProject("Old project");
    for (const settlement of [
      { startFresh: true },
      { projects: [{ projectId: project, answer: "drop_all" as const }] }
    ]) {
      await lapse(24 * 9);
      const result = await reenter(sql as never, command({ settlement }), NOW);
      expect(result).toMatchObject({ reentered: true, confirmedBy: "person" });
    }
  });
});

describe("an agent's location, energy and contexts are the owner's words (F21, F28)", () => {
  it.each([
    ["inferred", { basis: "inferred" as const }],
    ["missing", {}]
  ])("refuses an agent's facts sent with basis %s, writing nothing, and says how to resend", async (_name, extra) => {
    await lapse(3);
    const error = await asAgent(() => reenter(sql as never, command(extra), NOW)).catch((caught) => caught);
    expect(error).toBeInstanceOf(ReentryIncompleteError);
    const message = (error as Error).message;
    expect(message).toContain("ask the owner");
    expect(message).toContain("basis stated");
    expect(message).toContain("evidence set to the owner's own words");
    expect(message).toContain("cannot be reached, stop");
    expect((await openSegment())?.reason).toBe("lapsed");
    expect(await reenterWrites()).toBe(0);
  });

  it("lets the same facts through with basis stated and the owner's words, and the person path is unchanged", async () => {
    await lapse(3);
    const done = await asAgent(() => reenter(sql as never, command(STATED), NOW));
    expect(done).toMatchObject({ reentered: true, confirmedBy: "agent" });
    expect(done.next).toContain("rhen_undo");
    await lapse(3);
    // The person sends no basis at all and is not refused.
    expect(await reenter(sql as never, command(), new Date(NOW.getTime() + 1000))).toMatchObject({
      reentered: true,
      confirmedBy: "person"
    });
  });

  it("does not mention a settlement in the refusal when the gap has nothing to review (F20)", async () => {
    await lapse(50);
    const error = await reenter(
      sql as never,
      reenterCommandSchema.parse({ commandId: crypto.randomUUID(), locationId: "home" }),
      NOW
    ).catch((caught) => caught);
    expect(error).toBeInstanceOf(ReentryIncompleteError);
    expect((error as ReentryIncompleteError).body.tier).toBe("days");
    expect((error as Error).message).toContain("settlement-json may be left out");
    expect((error as Error).message).not.toContain("settlement.days");
  });
});

describe("the agent gate against a real lapsed pulse", () => {
  it("reads the pulse the recorder left and refuses, then lets calls through once re-entered", async () => {
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = testUrl.toString();
    try {
      await lapse(2);
      const refused = await reentryGate("/api/state", NOW);
      expect(refused?.status).toBe(428);
      expect(await refused?.json()).toMatchObject({
        code: "reentryRequired",
        pulse: { state: "off", reason: "lapsed" }
      });
      await reenter(sql as never, command(), NOW);
      expect(await reentryGate("/api/state", NOW)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

describe("unrecorded answers teach nothing", () => {
  it("settles through catch-up unchanged: a bulk skip still writes missed, not completed", async () => {
    const project = await createProject("Habits", {});
    const occurrence = await createOccurrence(project, hoursAgo(10));
    await settleCatchUp(
      sql as never,
      { commandId: crypto.randomUUID(), verdicts: [{ bulk: "all_skipped" }], closeWindow: false, basis: "inferred" },
      NOW
    );
    expect(await occurrenceStatus(occurrence)).toBe("missed");
  });
});
