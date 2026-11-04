import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "../persistence/postgres/ensure-user";
import { resolveEffectivePrivacy, runPulseRecorderTick } from "./pulse-recorder";
import { readPulseState } from "./pulse-read";
import { writeReentrySegment } from "./pulse-reentry";

/**
 * The pulse criteria and publish design note, "Recording" and its Testing section: segments open and
 * close on change only; a gap after an outage; back-fill of an unconfirmed run on a late confirmation,
 * stopping at a segment that fails the test; concurrent calls write one segment. Self-contained `_test`
 * database, the same pattern as `session-clock.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PULSE_RECORDER_TEST_DATABASE_NAME,
  "openrhen_pulse_recorder"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PULSE_RECORDER_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

async function createCommitment(overrides: Partial<{ title: string }> = {}): Promise<string> {
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status)
    VALUES (${id},${userId},${overrides.title ?? "Work"},${new Date(Date.now() - 3_600_000)},${new Date(Date.now() + 3_600_000)},'confirmed')
  `;
  return id;
}

/** A commitment-anchored routine step "in its scheduled window" — protectedInForce's simplest case,
    reachable with no `planning_runs` row at all. */
/** A located commitment in force via a stored `planning_runs.result.derivedState.commitmentTimelines`
    entry — the arrival-confirmation path's own `protectedInForce` source, unlike the routine-step
    fixture above (which needs no `planning_runs` row at all). */
async function createLocatedCommitmentInForce(
  now: Date,
  locationId: string,
  title = "Dinner",
  extra: {
    endsInMinutes?: number;
    startedAgoMinutes?: number;
    promptPolicy?: string;
    checkInExtraMinutes?: number | null;
  } = {}
): Promise<string> {
  const commitmentId = crypto.randomUUID();
  const startsAt = new Date(now.getTime() - (extra.startedAgoMinutes ?? 5) * 60_000);
  const endsAt = new Date(now.getTime() + (extra.endsInMinutes ?? 30) * 60_000);
  await sql`
    INSERT INTO commitments (id,user_id,title,starts_at,ends_at,status,location_id,prompt_policy,check_in_extra_minutes)
    VALUES (${commitmentId},${userId},${title},${startsAt},${endsAt},'confirmed',${locationId},${extra.promptPolicy ?? "normal"},${extra.checkInExtraMinutes ?? null})
  `;
  await sql`
    INSERT INTO planning_runs (user_id,request_id,input_version,contract_version,engine_version,calculated_at,valid_until,result)
    VALUES (
      ${userId},${crypto.randomUUID()},'v1','1','v1',${now},${new Date(now.getTime() + 3_600_000)},
      ${sql.json({
        contractVersion: "1",
        requestId: crypto.randomUUID(),
        inputVersion: "v1",
        engineVersion: "v1",
        calculatedAt: now.toISOString(),
        validUntil: new Date(now.getTime() + 3_600_000).toISOString(),
        derivedState: {
          sleepPlans: [],
          occurrences: [],
          routineSteps: [],
          commitmentRepeats: [],
          commitmentTimelines: [
            {
              id: commitmentId,
              setupStartsAt: startsAt.toISOString(),
              arriveBy: startsAt.toISOString(),
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              effectiveEndsAt: endsAt.toISOString(),
              freeAt: endsAt.toISOString(),
              protectedUntil: endsAt.toISOString(),
              overtime: false,
              latenessMatters: true
            }
          ],
          stepPlacements: []
        },
        schedule: {},
        recommendation: {},
        currentDirective: { kind: "none", title: "Nothing directed", recommendedMinutes: 0 },
        upcomingDirectives: [],
        continuation: null
      } as never)}
    )
  `;
  return commitmentId;
}

async function setSituation(locationId: string, locationSetAt: Date): Promise<void> {
  await sql`
    UPDATE user_preferences SET current_situation=${sql.json({
      locationId,
      locationSetAt: locationSetAt.toISOString(),
      overrides: {},
      carrying: {}
    } as never)}
    WHERE user_id=${userId}
  `;
}

async function createInForceStep(
  now: Date,
  title = "Prep",
  windowMinutes = 30,
  startedAgoMinutes = 5
): Promise<string> {
  const commitmentId = await createCommitment();
  const id = crypto.randomUUID();
  await sql`
    INSERT INTO routine_steps
      (id,user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,status,
       scheduled_start_at,scheduled_end_at)
    VALUES
      (${id},${userId},${commitmentId},'commitment',${commitmentId},${title},10,0,'contiguous','pending',
       ${new Date(now.getTime() - startedAgoMinutes * 60_000)},${new Date(now.getTime() + windowMinutes * 60_000)})
  `;
  return id;
}

async function openSegment(): Promise<
  { id: string; started_at: Date; state: string; reason: string | null; expected_id: string | null } | undefined
> {
  const rows = await sql<
    { id: string; started_at: Date; state: string; reason: string | null; expected_id: string | null }[]
  >`SELECT id, started_at, state, reason, expected_id FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL`;
  return rows[0];
}

async function allSegments(): Promise<
  {
    id: string;
    started_at: Date;
    ended_at: Date | null;
    state: string;
    reason: string | null;
    repainted_at: Date | null;
  }[]
> {
  return sql<
    {
      id: string;
      started_at: Date;
      ended_at: Date | null;
      state: string;
      reason: string | null;
      repainted_at: Date | null;
    }[]
  >`SELECT id, started_at, ended_at, state, reason, repainted_at FROM pulse_segments WHERE user_id=${userId} ORDER BY started_at`;
}

beforeAll(async () => {
  const admin = postgres(adminUrl!, { max: 1, connect_timeout: 10 });
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
    await migrate(drizzle(migrationSql), {
      migrationsFolder: fileURLToPath(new URL("../../../platform/database/drizzle", import.meta.url))
    });
  } finally {
    await migrationSql.end();
  }
  // `fetch_types: true` (unlike other integration tests here) because the recorder's back-fill query
  // uses `= ANY(${ids})`, which needs postgres.js to resolve the array element's OID to serialize a
  // real array literal — see `sql-pool.ts`'s own comment on the same pattern.
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: true, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE pulse_segments, pulse_state, pulse_disruptions, push_outbox, writes, write_rows, sleep_plans, check_in, session_segments, sessions, routine_steps, commitments, planning_runs, actions, projects, outcomes, areas, commitment_recurrence_rules RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET current_situation='{"locationId":null,"overrides":{},"carrying":{}}', pulse_unknown_to_off_minutes=NULL, pulse_further_prompts=NULL, pulse_unknown_hard_off_minutes=NULL WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("segments open and close on change only", () => {
  it("writes exactly one segment across two ticks when nothing changed", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    await runPulseRecorderTick(sql, t0);
    const t1 = new Date(t0.getTime() + 30_000);
    await runPulseRecorderTick(sql, t1);

    const segments = await allSegments();
    expect(segments).toHaveLength(1);
    expect(segments[0]!.state).toBe("free");
    expect(segments[0]!.ended_at).toBeNull();
  });

  it("closes the open segment and opens a new one once the judgement changes", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    await runPulseRecorderTick(sql, t0);
    const stepId = await createInForceStep(new Date(t0.getTime() + 60_000));
    const t1 = new Date(t0.getTime() + 60_000);
    await runPulseRecorderTick(sql, t1);

    const segments = await allSegments();
    expect(segments).toHaveLength(2);
    expect(segments[0]!.state).toBe("free");
    expect(segments[0]!.ended_at!.getTime()).toBe(t1.getTime());
    // A new block with no prompt yet is not a missed one: it holds `on` until a prompt can be missed.
    expect(segments[1]!.state).toBe("on");
    expect(segments[1]!.ended_at).toBeNull();

    const open = await openSegment();
    expect(open?.expected_id).toBe(stepId);
  });
});

describe("outage gap", () => {
  it("inserts a gap segment when the recorder was silent over 5 minutes", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    await runPulseRecorderTick(sql, t0);

    // Simulate an outage: back-date the recorder's own bookkeeping.
    const outageStart = new Date(t0.getTime() + 60_000);
    await sql`UPDATE pulse_state SET last_evaluated_at=${outageStart} WHERE user_id=${userId}`;

    const resumedAt = new Date(outageStart.getTime() + 10 * 60_000);
    await runPulseRecorderTick(sql, resumedAt);

    const segments = await allSegments();
    expect(segments).toHaveLength(3);
    // The original open segment, closed at the outage's start, not at resumedAt.
    expect(segments[0]!.ended_at!.getTime()).toBe(outageStart.getTime());
    // The gap itself, spanning the whole silent window.
    expect(segments[1]!.state).toBe("gap");
    expect(segments[1]!.started_at.getTime()).toBe(outageStart.getTime());
    expect(segments[1]!.ended_at!.getTime()).toBe(resumedAt.getTime());
    // A fresh segment judged at resumedAt.
    expect(segments[2]!.started_at.getTime()).toBe(resumedAt.getTime());
    expect(segments[2]!.ended_at).toBeNull();
  });
});

describe("handover back-fill", () => {
  it("repaints an unconfirmed run once a late check-in answer confirms it, stopping at a deviated segment", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky

    // An older, already-closed run: off/unconfirmed for a different step, then a deviated lapse right
    // before the run this test actually confirms — both synthetic, so the walk's stop condition is
    // exercised without needing several real ticks to produce it.
    const otherStepId = crypto.randomUUID();
    await sql`
      INSERT INTO pulse_segments (user_id,started_at,ended_at,state,reason,expected_kind,expected_id,private)
      VALUES (${userId},${new Date(t0.getTime() - 8 * 60_000)},${new Date(t0.getTime() - 6 * 60_000)},'off','unconfirmed','step',${otherStepId},false)
    `;
    const firstTickAt = new Date(t0.getTime() - 2 * 60_000);
    const stepId = await createInForceStep(firstTickAt, "Prep", 30, 120);
    await sql`
      INSERT INTO pulse_segments (user_id,started_at,ended_at,state,reason,expected_kind,expected_id,private)
      VALUES (${userId},${new Date(t0.getTime() - 6 * 60_000)},${firstTickAt},'off','deviated','step',${stepId},false)
    `;

    // The run this test confirms: off/unconfirmed for `stepId`, open until the first real tick below.
    await runPulseRecorderTick(sql, firstTickAt);
    const beforeConfirm = await allSegments();
    expect(beforeConfirm.at(-1)!.state).toBe("unknown");
    expect(beforeConfirm.at(-1)!.reason).toBe("unconfirmed");

    // A check-in answered `on_track` a few minutes ago confirms the step.
    const answeredAt = new Date(t0.getTime() - 60_000);
    await sql`
      INSERT INTO check_in (user_id,slot_at,directive_kind,directive_target_id,directive_title,status,answered_at)
      VALUES (${userId},${answeredAt},'routine_step',${stepId},'Prep','on_track',${answeredAt})
    `;

    await runPulseRecorderTick(sql, t0);

    const after = await allSegments();
    // The run just confirmed is repainted to on/confirmed (same bounds, `repainted_at` set) —
    // everything from the deviated segment forward stays exactly as it was.
    const repainted = after.find((row) => row.started_at.getTime() === firstTickAt.getTime());
    expect(repainted?.state).toBe("on");
    expect(repainted?.reason).toBe("confirmed");
    expect(repainted?.repainted_at).not.toBeNull();

    const deviated = after.find((row) => row.reason === "deviated");
    expect(deviated?.state).toBe("off");
    expect(deviated?.repainted_at).toBeNull();

    const other = after.find((row) => row.ended_at?.getTime() === t0.getTime() - 6 * 60_000);
    expect(other?.state).toBe("off");
    expect(other?.repainted_at).toBeNull();

    const open = await openSegment();
    expect(open?.state).toBe("on");
    expect(open?.reason).toBe("confirmed");
  });

  it("repaints an unconfirmed run once a late arrival confirms a located commitment", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    const locationId = "home";

    const firstTickAt = new Date(t0.getTime() - 2 * 60_000);
    const commitmentId = await createLocatedCommitmentInForce(firstTickAt, locationId, "Dinner", {
      startedAgoMinutes: 120
    });

    // Off/unconfirmed for the commitment, open until the arrival below confirms it.
    await runPulseRecorderTick(sql, firstTickAt);
    const beforeArrival = await allSegments();
    expect(beforeArrival.at(-1)!.state).toBe("unknown");
    expect(beforeArrival.at(-1)!.reason).toBe("unconfirmed");

    // Arrived a couple of minutes ago — a fresh location assertion matching the commitment's own place.
    const arrivedAt = new Date(t0.getTime() - 60_000);
    await setSituation(locationId, arrivedAt);

    await runPulseRecorderTick(sql, t0);

    const after = await allSegments();
    const repainted = after.find((row) => row.started_at.getTime() === firstTickAt.getTime());
    expect(repainted?.state).toBe("on");
    expect(repainted?.reason).toBe("confirmed");
    expect(repainted?.repainted_at).not.toBeNull();

    const openRows = await sql<{ state: string; reason: string | null; doing_id: string | null }[]>`
      SELECT state, reason, doing_id FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL
    `;
    expect(openRows[0]?.state).toBe("on");
    expect(openRows[0]?.reason).toBe("confirmed");
    expect(openRows[0]?.doing_id).toBe(commitmentId);
  });
});

describe("concurrent tick and notification", () => {
  it("writes one segment when two ticks race for the same change", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    await runPulseRecorderTick(sql, t0);
    const stepId = await createInForceStep(new Date(t0.getTime() + 60_000));
    const t1 = new Date(t0.getTime() + 60_000);

    await Promise.all([runPulseRecorderTick(sql, t1), runPulseRecorderTick(sql, t1)]);

    const segments = await allSegments();
    expect(segments).toHaveLength(2);
    expect(segments[1]!.started_at.getTime()).toBe(t1.getTime());
    const open = await openSegment();
    expect(open?.expected_id).toBe(stepId);
  });
});

describe("resolveEffectivePrivacy: inheritance against real rows", () => {
  it("a private area hides an action two levels down (area → outcome → project → action)", async () => {
    const area = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order,private) VALUES (${userId},'Area','active',0,true) RETURNING id
    `;
    const outcome = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id
    `;
    const project = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id
    `;
    const action = await sql<{ id: string }[]>`
      INSERT INTO actions
        (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,
         remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project[0]!.id},'Sort the bedroom floor','one_off','active',10,20,30,5,'medium',10,30)
      RETURNING id
    `;

    const privateTargets = await sql.begin((tx) => resolveEffectivePrivacy(tx, userId));
    expect(privateTargets.has(`action:${action[0]!.id}`)).toBe(true);
  });

  it("a non-private area does not hide its action", async () => {
    const area = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order,private) VALUES (${userId},'Area','active',0,false) RETURNING id
    `;
    const outcome = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id
    `;
    const project = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id
    `;
    const action = await sql<{ id: string }[]>`
      INSERT INTO actions
        (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,
         remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project[0]!.id},'Sort the bedroom floor','one_off','active',10,20,30,5,'medium',10,30)
      RETURNING id
    `;

    const privateTargets = await sql.begin((tx) => resolveEffectivePrivacy(tx, userId));
    expect(privateTargets.has(`action:${action[0]!.id}`)).toBe(false);
  });

  it("a private recurring series hides its occurrence and that occurrence's routine step", async () => {
    const rule = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules
        (user_id,title,timezone,start_date,interval_unit,interval_days,local_start_time,local_end_time,private)
      VALUES (${userId},'Standup','Australia/Sydney',${"2026-09-01"},'days',1,${"09:00"},${"09:15"},true)
      RETURNING id
    `;
    const occurrenceStartsAt = new Date();
    const occurrenceEndsAt = new Date(occurrenceStartsAt.getTime() + 15 * 60_000);
    const occurrence = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,status,recurrence_rule_id)
      VALUES (${userId},'Standup',${occurrenceStartsAt},${occurrenceEndsAt},'confirmed',${rule[0]!.id})
      RETURNING id
    `;
    const step = await sql<{ id: string }[]>`
      INSERT INTO routine_steps
        (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,status,
         scheduled_start_at,scheduled_end_at)
      VALUES
        (${userId},${occurrence[0]!.id},'commitment',${occurrence[0]!.id},'Prep',5,0,'contiguous','pending',
         ${occurrenceStartsAt},${occurrenceEndsAt})
      RETURNING id
    `;

    const privateTargets = await sql.begin((tx) => resolveEffectivePrivacy(tx, userId));
    expect(privateTargets.has(`commitment:${occurrence[0]!.id}`)).toBe(true);
    expect(privateTargets.has(`journey:${occurrence[0]!.id}`)).toBe(true);
    expect(privateTargets.has(`step:${step[0]!.id}`)).toBe(true);
  });

  it("a non-private series does not hide its occurrence's routine step", async () => {
    const rule = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules
        (user_id,title,timezone,start_date,interval_unit,interval_days,local_start_time,local_end_time,private)
      VALUES (${userId},'Standup','Australia/Sydney',${"2026-09-01"},'days',1,${"09:00"},${"09:15"},false)
      RETURNING id
    `;
    const occurrenceStartsAt = new Date();
    const occurrenceEndsAt = new Date(occurrenceStartsAt.getTime() + 15 * 60_000);
    const occurrence = await sql<{ id: string }[]>`
      INSERT INTO commitments (user_id,title,starts_at,ends_at,status,recurrence_rule_id)
      VALUES (${userId},'Standup',${occurrenceStartsAt},${occurrenceEndsAt},'confirmed',${rule[0]!.id})
      RETURNING id
    `;
    const step = await sql<{ id: string }[]>`
      INSERT INTO routine_steps
        (user_id,commitment_id,anchor_type,anchor_id,title,duration_minutes,sequence,timing_rule,status,
         scheduled_start_at,scheduled_end_at)
      VALUES
        (${userId},${occurrence[0]!.id},'commitment',${occurrence[0]!.id},'Prep',5,0,'contiguous','pending',
         ${occurrenceStartsAt},${occurrenceEndsAt})
      RETURNING id
    `;

    const privateTargets = await sql.begin((tx) => resolveEffectivePrivacy(tx, userId));
    expect(privateTargets.has(`commitment:${occurrence[0]!.id}`)).toBe(false);
    expect(privateTargets.has(`step:${step[0]!.id}`)).toBe(false);
  });
});

const MIN = 60_000;
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * MIN);
/** Seed-zone midday: no local midnight falls inside a test, which a real clock near midnight would not guarantee. */
const MIDDAY = "2026-10-28T02:00:00.000Z";

async function stateRow() {
  const rows = await sql<
    {
      last_contact_at: Date | null;
      last_contact_source: string | null;
      unknown_since: Date | null;
      unknown_minutes: number;
      unanswered_prompts: number;
      silence_until: Date | null;
      entered_lapsed_at: Date | null;
      confirmed_by: string | null;
      last_confirmed_at: Date | null;
      reentered_at: Date | null;
    }[]
  >`SELECT * FROM pulse_state WHERE user_id=${userId}`;
  return rows[0]!;
}

/** Someone the system has heard from before: an old contact, so a lapse has something to time out from. */
async function seedHistory(t0: Date): Promise<void> {
  await writeAt(at(t0, -300), "finish_activity", null);
}

async function promptAt(when: Date): Promise<void> {
  await sql`
    INSERT INTO check_in (user_id,slot_at,directive_kind,directive_target_id,directive_title,status,prompted_at)
    VALUES (${userId},${when},'routine_step',${crypto.randomUUID()},'Prep','unknown',${when})
  `;
}

async function writeAt(when: Date, commandType: string, actor: string | null): Promise<void> {
  await sql`
    INSERT INTO writes (id,user_id,command_type,actor,created_at) VALUES (${crypto.randomUUID()},${userId},${commandType},${actor},${when})
  `;
}

/** Ticks every `step` minutes from `from` (exclusive) to `to` (inclusive), as the worker's tick would. */
async function tickThrough(from: Date, to: Date, step = 5) {
  let last: Awaited<ReturnType<typeof runPulseRecorderTick>> | undefined;
  for (let t = from.getTime() + step * MIN; t <= to.getTime(); t += step * MIN) {
    last = await runPulseRecorderTick(sql, new Date(t));
  }
  return last;
}

describe("state machine: unknown, lapsed and the allowance", () => {
  it("goes unknown, then off/lapsed after 30 minutes with a further prompt, and records the lapse once", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.state).toBe("unknown");

    await promptAt(at(t0, 16));
    await tickThrough(t0, at(t0, 29));
    expect((await openSegment())?.state).toBe("unknown");
    expect((await stateRow()).unanswered_prompts).toBe(1);

    await runPulseRecorderTick(sql, at(t0, 30));
    const lapsed = await openSegment();
    expect(lapsed?.state).toBe("off");
    expect(lapsed?.reason).toBe("lapsed");
    const entered = (await stateRow()).entered_lapsed_at;
    expect(entered?.getTime()).toBe(at(t0, 30).getTime());

    await tickThrough(at(t0, 30), at(t0, 60));
    expect((await stateRow()).entered_lapsed_at?.getTime()).toBe(entered!.getTime());
    const segments = await allSegments();
    expect(segments.map((row) => `${row.state}/${row.reason}`)).toEqual(["unknown/unconfirmed", "off/lapsed"]);
  });

  it("lapses at 60 minutes with no further prompt", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 55));
    expect((await openSegment())?.state).toBe("unknown");
    await tickThrough(at(t0, 55), at(t0, 60));
    expect((await openSegment())?.state).toBe("off");
  });

  it("reads the lapse thresholds from the settings", async () => {
    await sql`UPDATE user_preferences SET pulse_unknown_to_off_minutes=10, pulse_further_prompts=0, pulse_unknown_hard_off_minutes=20 WHERE user_id=${userId}`;
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 10));
    expect((await openSegment())?.state).toBe("off");
  });

  it("a commitment's check-in allowance lengthens both limits (default 15, or its own)", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createLocatedCommitmentInForce(t0, "elsewhere", "Appointment", {
      endsInMinutes: 600,
      startedAgoMinutes: 120
    });
    await runPulseRecorderTick(sql, t0);
    await promptAt(at(t0, 16));
    await tickThrough(t0, at(t0, 40));
    // 30 + 15 = 45 minutes: still unknown at 40 even with a further prompt sent.
    expect((await openSegment())?.state).toBe("unknown");
    await tickThrough(at(t0, 40), at(t0, 45));
    expect((await openSegment())?.state).toBe("off");
  });

  it("a custom allowance of 0 gives the plain limits, and a rule's allowance is inherited", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createLocatedCommitmentInForce(t0, "elsewhere", "Appointment", {
      endsInMinutes: 600,
      startedAgoMinutes: 120,
      checkInExtraMinutes: 0
    });
    await runPulseRecorderTick(sql, t0);
    await promptAt(at(t0, 16));
    await tickThrough(t0, at(t0, 30));
    expect((await openSegment())?.state).toBe("off");

    await sql.unsafe(
      "TRUNCATE TABLE pulse_segments, pulse_state, check_in, commitments, planning_runs, commitment_recurrence_rules CASCADE"
    );
    const rule = await sql<{ id: string }[]>`
      INSERT INTO commitment_recurrence_rules
        (user_id,title,timezone,start_date,interval_unit,interval_days,local_start_time,local_end_time,check_in_extra_minutes)
      VALUES (${userId},'Class','Australia/Sydney',${"2026-09-01"},'days',1,${"09:00"},${"10:00"},60) RETURNING id
    `;
    const t1 = new Date("2026-10-28T02:00:00.000Z");
    const occurrence = await createLocatedCommitmentInForce(t1, "elsewhere", "Class", {
      endsInMinutes: 600,
      startedAgoMinutes: 120
    });
    await sql`UPDATE commitments SET recurrence_rule_id=${rule[0]!.id} WHERE id=${occurrence}`;
    await runPulseRecorderTick(sql, t1);
    await promptAt(at(t1, 16));
    await tickThrough(t1, at(t1, 80));
    // 30 + 60 = 90 from the rule.
    expect((await openSegment())?.state).toBe("unknown");
    await tickThrough(at(t1, 80), at(t1, 90));
    expect((await openSegment())?.state).toBe("off");
  });

  it("a confirming answer in time repaints the unknown time and goes back on", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    const stepId = await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 20));
    const answeredAt = at(t0, 21);
    await sql`
      INSERT INTO check_in (user_id,slot_at,directive_kind,directive_target_id,directive_title,status,answered_at)
      VALUES (${userId},${answeredAt},'routine_step',${stepId},'Prep','on_track',${answeredAt})
    `;
    await writeAt(answeredAt, "answer_check_in", "claude");
    await runPulseRecorderTick(sql, at(t0, 22));
    const open = await openSegment();
    expect(open?.state).toBe("on");
    expect(open?.reason).toBe("confirmed");
    const row = await stateRow();
    expect(row.unknown_since).toBeNull();
    expect(row.last_contact_source).toBe("agent");
    const segments = await allSegments();
    expect(segments.filter((s) => s.state === "unknown")).toHaveLength(0);
    expect(segments.some((s) => s.repainted_at !== null)).toBe(true);
  });
});

describe("state machine: contact", () => {
  it("records person and agent contact from the write ledger, never a system write or a plan edit", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await runPulseRecorderTick(sql, t0);
    await writeAt(at(t0, 1), "save_commitment_recurrence_rule", "claude");
    await writeAt(at(t0, 2), "finish_activity", "system");
    await runPulseRecorderTick(sql, at(t0, 3));
    expect((await stateRow()).last_contact_at).toBeNull();

    await writeAt(at(t0, 4), "current_availability", "claude");
    await runPulseRecorderTick(sql, at(t0, 5));
    let row = await stateRow();
    expect(row.last_contact_source).toBe("agent");
    expect(row.last_contact_at?.getTime()).toBe(at(t0, 4).getTime());

    await writeAt(at(t0, 6), "start_activity", null);
    await runPulseRecorderTick(sql, at(t0, 7));
    row = await stateRow();
    expect(row.last_contact_source).toBe("person");
  });

  it("a bare contact while lapsed does not heal it", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60));
    expect((await openSegment())?.state).toBe("off");
    await writeAt(at(t0, 61), "answer_check_in", null);
    await tickThrough(at(t0, 60), at(t0, 70));
    expect((await openSegment())?.state).toBe("off");
    expect((await stateRow()).last_contact_at).not.toBeNull();
  });

  it("a re-entry stamped on pulse_state heals a lapse once, with who made it", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60));
    await sql`UPDATE pulse_state SET reentered_at=${at(t0, 61)}, reentered_by='agent' WHERE user_id=${userId}`;
    await runPulseRecorderTick(sql, at(t0, 62));
    const open = await openSegment();
    expect(open?.state).toBe("on");
    expect(open?.reason).toBe("reentered");
    const row = await stateRow();
    expect(row.reentered_at).toBeNull();
    expect(row.confirmed_by).toBe("agent");
    expect(row.last_confirmed_at?.getTime()).toBe(at(t0, 61).getTime());
  });

  it("an outage does not heal a lapse, and does not count as time unknown", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 6000, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60));
    expect((await openSegment())?.state).toBe("off");
    await runPulseRecorderTick(sql, at(t0, 200));
    expect((await openSegment())?.state).toBe("off");
    expect((await openSegment())?.reason).toBe("lapsed");

    await sql.unsafe("TRUNCATE TABLE pulse_segments, pulse_state, check_in CASCADE");
    const t1 = new Date("2026-10-28T02:00:00.000Z");
    await runPulseRecorderTick(sql, t1);
    await tickThrough(t1, at(t1, 20));
    await runPulseRecorderTick(sql, at(t1, 120));
    // 20 minutes unknown before the outage, none during it.
    const row = await stateRow();
    expect(row.unknown_minutes).toBeLessThan(25);
    expect((await openSegment())?.state).toBe("unknown");
  });
});

describe("state machine: expected silence", () => {
  it("holds on/scheduled through a silent commitment, then lapses hard 60 minutes after it with no contact", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createLocatedCommitmentInForce(t0, "work", "Shift", { endsInMinutes: 480, promptPolicy: "silent" });
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 240), 30);
    let open = await openSegment();
    expect(open?.state).toBe("on");
    expect(open?.reason).toBe("scheduled");
    const row = await stateRow();
    expect(row.silence_until).not.toBeNull();
    expect(row.last_confirmed_at).toBeNull();
    const wire = await readPulseState(sql, userId, at(t0, 240), "Australia/Sydney");
    expect(wire?.state).toBe("on");
    expect(wire?.reason).toBe("scheduled");
    expect(wire?.silenceUntil).toBeDefined();
    expect(wire?.lastConfirmedAt).toBeUndefined();

    // The shift ends (the commitment leaves the plan), a step is directed, and nobody has said a word.
    await sql`UPDATE commitments SET ends_at=${at(t0, 480)} WHERE user_id=${userId}`;
    await createInForceStep(at(t0, 485), "Prep", 600);
    await tickThrough(at(t0, 240), at(t0, 480), 30);
    await tickThrough(at(t0, 480), at(t0, 535), 5);
    open = await openSegment();
    expect(open?.state).toBe("on");
    await tickThrough(at(t0, 535), at(t0, 545), 5);
    open = await openSegment();
    expect(open?.state).toBe("off");
    expect(open?.reason).toBe("lapsed");
  });
});

describe("readPulseState: the machine's fields", () => {
  it("carries unknown, the off reason, who confirmed and leaves unknown out of the shares", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 20));
    let wire = await readPulseState(sql, userId, at(t0, 20), "Australia/Sydney");
    expect(wire?.state).toBe("unknown");
    expect(wire?.offReason).toBeUndefined();
    expect(wire?.shares.today.countedMinutes).toBe(0);

    await tickThrough(at(t0, 20), at(t0, 60));
    wire = await readPulseState(sql, userId, at(t0, 60), "Australia/Sydney");
    expect(wire?.state).toBe("off");
    expect(wire?.reason).toBe("lapsed");
    expect(wire?.offReason).toBe("lapsed");
    // Only the lapsed minutes count (unknown time is uncounted, like a gap).
    expect(wire?.shares.today.countedMinutes).toBeLessThanOrEqual(30);
  });

  it("names who confirmed", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    const stepId = await createInForceStep(t0, "Prep", 600, 120);
    await writeAt(at(t0, -1), "answer_check_in", "claude");
    await sql`
      INSERT INTO check_in (user_id,slot_at,directive_kind,directive_target_id,directive_title,status,answered_at)
      VALUES (${userId},${at(t0, -1)},'routine_step',${stepId},'Prep','on_track',${at(t0, -1)})
    `;
    await runPulseRecorderTick(sql, t0);
    const wire = await readPulseState(sql, userId, t0, "Australia/Sydney");
    expect(wire?.state).toBe("on");
    expect(wire?.confirmedBy).toBe("agent");
    expect(wire?.lastConfirmedAt).toBeDefined();
  });
});

describe("state machine: disruptions", () => {
  async function disrupt(until: Date, createdAt: Date) {
    await sql`
      INSERT INTO pulse_disruptions (user_id,doing,until,location_id,contexts,exclusive,recorded_by,created_at)
      VALUES (${userId},'Hospital visit',${until},'hospital',${sql.json(["phone"] as never)},true,'person',${createdAt})`;
  }
  async function answer(stepId: string, status: "deviated" | "on_track", when: Date) {
    await sql`
      INSERT INTO check_in (user_id,slot_at,directive_kind,directive_target_id,directive_title,status,answered_at)
      VALUES (${userId},${when},'routine_step',${stepId},'Prep',${status},${when})`;
  }

  it("a deviation with no disruption lapses at once", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    const stepId = await createInForceStep(t0, "Prep", 600);
    await answer(stepId, "deviated", at(t0, -1));
    await runPulseRecorderTick(sql, t0);
    const open = await openSegment();
    expect(`${open?.state}/${open?.reason}`).toBe("off/lapsed");
  });

  it("holds on/disrupted while the disruption runs, then goes unknown from its until", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    const stepId = await createInForceStep(t0, "Prep", 600);
    await answer(stepId, "deviated", at(t0, -1));
    await disrupt(at(t0, 30), at(t0, -1));
    await runPulseRecorderTick(sql, t0);
    expect(`${(await openSegment())?.state}/${(await openSegment())?.reason}`).toBe("on/disrupted");

    await tickThrough(t0, at(t0, 25));
    expect(`${(await openSegment())?.state}/${(await openSegment())?.reason}`).toBe("on/disrupted");
    const wire = await readPulseState(sql, userId, at(t0, 25), "UTC");
    expect(wire?.disruption).toMatchObject({ doing: "Hospital visit", locationId: "hospital", exclusive: true });

    await runPulseRecorderTick(sql, at(t0, 31));
    const after = await openSegment();
    expect(`${after?.state}/${after?.reason}`).toBe("unknown/unconfirmed");
    expect((await readPulseState(sql, userId, at(t0, 31), "UTC"))?.disruption).toBeUndefined();
    await runPulseRecorderTick(sql, at(t0, 36));
    expect((await openSegment())?.state).toBe("unknown");
  });

  it("a disruption recorded while the pulse is unknown (nothing confirmed, no deviated answer) holds it on, then unknown and lapsed after until", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 15));
    expect((await openSegment())?.state).toBe("unknown");

    await disrupt(at(t0, 60), at(t0, 15));
    await runPulseRecorderTick(sql, at(t0, 16));
    const held = await openSegment();
    expect(`${held?.state}/${held?.reason}`).toBe("on/disrupted");
    await tickThrough(at(t0, 16), at(t0, 55));
    expect((await openSegment())?.reason).toBe("disrupted");

    await tickThrough(at(t0, 55), at(t0, 65));
    expect((await openSegment())?.state).toBe("unknown");
    await tickThrough(at(t0, 65), at(t0, 125));
    const lapsed = await openSegment();
    expect(`${lapsed?.state}/${lapsed?.reason}`).toBe("off/lapsed");
  });

  it("a later on-track answer ends the disruption and goes back on; a stale one does not", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    const stepId = await createInForceStep(t0, "Prep", 600);
    await answer(stepId, "deviated", at(t0, -1));
    await disrupt(at(t0, 120), at(t0, -1));
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.reason).toBe("disrupted");

    await answer(stepId, "on_track", at(t0, 10));
    await runPulseRecorderTick(sql, at(t0, 11));
    const open = await openSegment();
    expect(`${open?.state}/${open?.reason}`).toBe("on/confirmed");
    const stored = await sql<{ ended_at: Date | null }[]>`SELECT ended_at FROM pulse_disruptions`;
    expect(stored[0]!.ended_at?.getTime()).toBe(at(t0, 11).getTime());
  });

  it("a confirmation older than the disruption leaves it standing", async () => {
    const t0 = new Date(MIDDAY); // pinned: a wall-clock t0 near local midnight made these flaky
    const stepId = await createInForceStep(t0, "Prep", 600);
    await answer(stepId, "on_track", at(t0, -10));
    await disrupt(at(t0, 120), at(t0, -5));
    await answer(stepId, "deviated", at(t0, -1));
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.reason).toBe("disrupted");
    const stored = await sql<{ ended_at: Date | null }[]>`SELECT ended_at FROM pulse_disruptions`;
    expect(stored[0]!.ended_at).toBeNull();
  });
});

describe("state machine: a missed confirmation, not a missing one", () => {
  it("a new block with no prompt yet does not go unknown, until a whole cadence and timeout pass", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await createInForceStep(t0, "Prep", 600, 5);
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.state).toBe("on");
    await tickThrough(t0, at(t0, 20));
    expect((await openSegment())?.state).toBe("on");
    // Block started 5 minutes before t0: 20 + 10 minutes later it is stale with no contact.
    await tickThrough(at(t0, 20), at(t0, 30));
    expect((await openSegment())?.state).toBe("unknown");
  });

  it("a prompt that timed out unanswered goes unknown at once", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    const stepId = await createInForceStep(t0, "Prep", 600, 5);
    await sql`
      INSERT INTO check_in (user_id,slot_at,directive_kind,directive_target_id,directive_title,status,prompted_at)
      VALUES (${userId},${at(t0, -4)},'routine_step',${stepId},'Prep','unknown',${at(t0, -4)})
    `;
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.state).toBe("unknown");
  });

  it("a re-entry stamped on pulse_state holds on, not unknown, on the next ticks", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60));
    expect((await openSegment())?.state).toBe("off");
    await sql`UPDATE pulse_state SET reentered_at=${at(t0, 61)}, reentered_by='person' WHERE user_id=${userId}`;
    await runPulseRecorderTick(sql, at(t0, 62));
    expect((await openSegment())?.reason).toBe("reentered");
    await tickThrough(at(t0, 62), at(t0, 80));
    const open = await openSegment();
    expect(open?.state).toBe("on");
    expect(open?.reason).toBe("reentered");
  });
});

describe("state machine: hourly cadence, early bed and what counts as contact", () => {
  it("a reduced (hourly) commitment is not unknown at the base cadence's limit", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await createLocatedCommitmentInForce(t0, "elsewhere", "Long thing", {
      endsInMinutes: 600,
      startedAgoMinutes: 5,
      promptPolicy: "reduced"
    });
    await runPulseRecorderTick(sql, t0);
    // Base cadence would be 20 + 10 + 15 = 45 minutes from the start; hourly is 60 + 10 + 15 = 85.
    await tickThrough(t0, at(t0, 70));
    expect((await openSegment())?.state).toBe("on");
    await tickThrough(at(t0, 70), at(t0, 85));
    expect((await openSegment())?.state).toBe("unknown");
    // And it is not lapsed at 90 minutes of silence before any prompt could be missed.
  });

  it("going to bed before the planned start is asleep, not a lapse from last night's ended window", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await sql`
      INSERT INTO sleep_plans (user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at,actual_wake_at)
      VALUES (${userId},${at(t0, -600 - 480)},${at(t0, -600)},480,480,'last night','completed',${at(t0, -600 - 480)},${at(t0, -600)}),
             (${userId},${at(t0, 60)},${at(t0, 60 + 480)},480,480,'tonight','sleeping',${at(t0, -5)},NULL)
    `;
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 180), 30);
    const open = await openSegment();
    expect(open?.state).toBe("asleep");
    const row = await stateRow();
    expect(row.entered_lapsed_at).toBeNull();
  });

  it("an agent's plan-preference edit is not contact, a wake write is", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z"); // seed-zone midday: no local midnight inside a test
    await runPulseRecorderTick(sql, t0);
    const write = async (when: Date, evidence: Record<string, unknown>) => {
      const id = crypto.randomUUID();
      await sql`INSERT INTO writes (id,user_id,command_type,actor,created_at) VALUES (${id},${userId},'settings','claude',${when})`;
      await sql`INSERT INTO write_rows (write_id,user_id,entity_type,entity_id,operation,evidence) VALUES (${id},${userId},'settings','x','save',${sql.json(evidence as never)})`;
    };
    await write(at(t0, 1), {});
    await runPulseRecorderTick(sql, at(t0, 2));
    expect((await stateRow()).last_contact_at).toBeNull();
    await write(at(t0, 3), { wake: true });
    await runPulseRecorderTick(sql, at(t0, 4));
    const row = await stateRow();
    expect(row.last_contact_source).toBe("agent");
    expect(row.last_contact_at?.getTime()).toBe(at(t0, 3).getTime());
  });
});

describe("state machine: a user never heard from does not lapse", () => {
  it("stays unknown on a first tick and for hours with a block in force and no history", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await createInForceStep(t0, "Prep", 900, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 180), 5);
    const open = await openSegment();
    expect(open?.state).toBe("unknown");
    const row = await stateRow();
    expect(row.entered_lapsed_at).toBeNull();
    const wire = await readPulseState(sql, userId, at(t0, 180), "Australia/Sydney");
    expect(wire?.state).toBe("unknown");
    expect(wire?.offReason).toBeUndefined();
  });

  it("does not lapse straight away on an unsanctioned session with no history", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    const area = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area','active',0) RETURNING id
    `;
    const outcome = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id
    `;
    const project = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id
    `;
    const action = await sql<{ id: string }[]>`
      INSERT INTO actions
        (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,
         remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project[0]!.id},'Write','one_off','active',10,20,30,5,'medium',10,30) RETURNING id
    `;
    await sql`
      INSERT INTO sessions
        (user_id,action_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,plan_sanction)
      VALUES (${userId},${action[0]!.id},'action',${action[0]!.id},'running',${at(t0, -10)},${at(t0, 50)},${at(t0, -10)},60,60,NULL)
    `;
    await runPulseRecorderTick(sql, t0);
    const open = await openSegment();
    expect(open?.state).toBe("unknown");
  });

  it("lapses once there is a prior contact to time out from", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 900, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60), 5);
    expect((await openSegment())?.state).toBe("off");
  });
});

describe("state machine: an overrunning session", () => {
  async function sessionOverran(t0: Date, endedMinutesAgo: number) {
    const area = await sql<{ id: string }[]>`
      INSERT INTO areas (user_id,name,status,sort_order) VALUES (${userId},'Area','active',0) RETURNING id
    `;
    const outcome = await sql<{ id: string }[]>`
      INSERT INTO outcomes (area_id,title,definition_of_done,status) VALUES (${area[0]!.id},'Outcome','Done','active') RETURNING id
    `;
    const project = await sql<{ id: string }[]>`
      INSERT INTO projects (outcome_id,title,status) VALUES (${outcome[0]!.id},'Project','active') RETURNING id
    `;
    const action = await sql<{ id: string }[]>`
      INSERT INTO actions
        (project_id,title,scheduling_mode,status,optimistic_minutes,expected_minutes,pessimistic_minutes,
         remaining_minutes,energy,minimum_session_minutes,maximum_session_minutes)
      VALUES (${project[0]!.id},'Write','one_off','active',10,20,30,5,'medium',10,30) RETURNING id
    `;
    const end = at(t0, -endedMinutesAgo);
    await sql`
      INSERT INTO sessions
        (user_id,action_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes,plan_sanction,sanction_until)
      VALUES (${userId},${action[0]!.id},'action',${action[0]!.id},'running',${at(end, -60)},${end},${at(end, -60)},60,60,'directive',${end})
    `;
  }

  it("holds on while the session is only a little over, and goes unknown once it is stale", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await sessionOverran(t0, 10);
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.state).toBe("on");
    // planned end + max(60, planned length 60) minutes: stale 50 minutes later.
    await tickThrough(t0, at(t0, 55), 5);
    const open = await openSegment();
    expect(open?.state).not.toBe("on");
  });
});

describe("state machine: a night still sleeping past its planned wake", () => {
  it("stays asleep until the cap, then unknown, never an instant lapse", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await sql`
      INSERT INTO sleep_plans (user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at)
      VALUES (${userId},${at(t0, -600)},${at(t0, -30)},480,480,'overslept','sleeping',${at(t0, -600)})
    `;
    // Something is directed, so once he no longer reads asleep the pulse has a block to be unsure about.
    await createInForceStep(t0, "Prep", 900, 700);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 120), 5);
    expect((await openSegment())?.state).toBe("asleep");
    // Planned wake was 30 minutes before t0; the cap is 3 hours after it.
    await tickThrough(at(t0, 120), at(t0, 160), 5);
    const open = await openSegment();
    expect(open?.state).toBe("unknown");
    expect((await stateRow()).entered_lapsed_at).toBeNull();
  });
});

describe("the one Back on plan? push", () => {
  const pushes = () =>
    sql<
      { dedupe_key: string; kind: string; status: string; payload: { title: string; url: string } }[]
    >`SELECT dedupe_key, kind, status, payload FROM push_outbox WHERE dedupe_key LIKE 'back-on-plan:%' ORDER BY created_at`;

  it("sends none for unknown, one when the pulse lapses, and never repeats it for the same lapse", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 55));
    expect((await openSegment())?.state).toBe("unknown");
    expect(await pushes()).toHaveLength(0);

    await tickThrough(at(t0, 55), at(t0, 60));
    expect((await openSegment())?.state).toBe("off");
    const queued = await pushes();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "test", status: "pending", payload: { title: "Back on plan?", url: "/" } });

    await tickThrough(at(t0, 60), at(t0, 180));
    // The same tick run again (the worker's tick and the debounced subscriber both call it) adds nothing either.
    await Promise.all([runPulseRecorderTick(sql, at(t0, 181)), runPulseRecorderTick(sql, at(t0, 181))]);
    expect(await pushes()).toHaveLength(1);
  });

  it("sends one more for a later lapse, and withdraws an unsent one when the pulse is re-entered", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60));
    expect(await pushes()).toHaveLength(1);

    await sql.begin((tx) => writeReentrySegment(tx, userId, { at: at(t0, 61), confirmedBy: "person", snapshot: null }));
    expect((await pushes())[0]!.status).toBe("cancelled");

    // Back on, then lost again: a new lapse is a new push.
    await sql`UPDATE pulse_state SET unknown_since=NULL, unknown_minutes=0 WHERE user_id=${userId}`;
    await sql`UPDATE pulse_segments SET ended_at=${at(t0, 70)} WHERE user_id=${userId} AND ended_at IS NULL`;
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason) VALUES (${userId}, ${at(t0, 70)}, 'unknown', 'unconfirmed')`;
    await sql`UPDATE pulse_state SET unknown_since=${at(t0, 70)}, entered_lapsed_at=NULL WHERE user_id=${userId}`;
    await tickThrough(at(t0, 70), at(t0, 135));
    expect((await openSegment())?.state).toBe("off");
    expect(await pushes()).toHaveLength(2);
  });
});

describe("the pulse_lapsed agent wake", () => {
  // Every earlier lapse in this file queued a wake of its own; this block counts only its own.
  beforeEach(async () => {
    await sql`DELETE FROM agent_wakes WHERE user_id=${userId}`;
  });

  const wakes = () =>
    sql<
      { target_id: string; status: string; last_error: string | null; expires_at: Date; created_at: Date }[]
    >`SELECT target_id, status, last_error, expires_at, created_at FROM agent_wakes WHERE user_id=${userId} AND event='pulse_lapsed'`;

  it("queues one wake when the pulse lapses, none for unknown, and none again for the same lapse", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 55));
    expect(await wakes()).toHaveLength(0);

    await tickThrough(at(t0, 55), at(t0, 60));
    const queued = await wakes();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "pending", last_error: null });
    expect(new Date(queued[0]!.target_id).toISOString()).toBe(queued[0]!.target_id);
    expect(queued[0]!.expires_at.getTime() - at(t0, 60).getTime()).toBe(60 * 60_000);

    await tickThrough(at(t0, 60), at(t0, 180));
    await Promise.all([runPulseRecorderTick(sql, at(t0, 181)), runPulseRecorderTick(sql, at(t0, 181))]);
    expect(await wakes()).toHaveLength(1);
  });

  it("marks a still-pending wake dead as cancelled when the pulse is re-entered, and leaves a sent one alone", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    await tickThrough(t0, at(t0, 60));
    expect((await wakes())[0]).toMatchObject({ status: "pending", last_error: null });
    await sql`INSERT INTO agent_wakes (user_id,event,target_id,dedupe_key,expires_at,status)
      VALUES (${userId},'pulse_lapsed','earlier','pulse_lapsed:earlier',${at(t0, 120).toISOString()}::timestamptz,'sent')`;

    await sql.begin((tx) => writeReentrySegment(tx, userId, { at: at(t0, 61), confirmedBy: "person", snapshot: null }));
    const after = await sql<
      { target_id: string; status: string; last_error: string | null }[]
    >`SELECT target_id, status, last_error FROM agent_wakes WHERE user_id=${userId} AND event='pulse_lapsed' ORDER BY target_id`;
    expect(after.find((w) => w.target_id === "earlier")).toMatchObject({ status: "sent", last_error: null });
    expect(after.filter((w) => w.target_id !== "earlier")).toEqual([
      expect.objectContaining({ status: "dead", last_error: "cancelled" })
    ]);
  });
});

describe("the pulse_unknown agent wake", () => {
  beforeEach(async () => {
    await sql`DELETE FROM agent_wakes WHERE user_id=${userId}`;
  });

  const wakes = () =>
    sql<
      { target_id: string; status: string; last_error: string | null; expires_at: Date }[]
    >`SELECT target_id, status, last_error, expires_at FROM agent_wakes WHERE user_id=${userId} AND event='pulse_unknown'`;

  it("queues exactly one wake when an unknown segment opens, not on later ticks", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.state).toBe("unknown");
    const queued = await wakes();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "pending", target_id: t0.toISOString() });
    expect(queued[0]!.expires_at.getTime() - t0.getTime()).toBe(30 * 60_000);

    await tickThrough(t0, at(t0, 25));
    expect(await wakes()).toHaveLength(1);
  });

  it("queues none when any wake was created for the user in the last 30 minutes", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await sql`INSERT INTO agent_wakes (user_id,event,target_id,dedupe_key,expires_at,status,created_at)
      VALUES (${userId},'check_in_unanswered','c1','check_in_unanswered:c1',${at(t0, 10).toISOString()}::timestamptz,'sent',${at(t0, -10).toISOString()}::timestamptz)`;
    await runPulseRecorderTick(sql, t0);
    expect((await openSegment())?.state).toBe("unknown");
    expect(await wakes()).toHaveLength(0);
  });

  it("marks a pending wake dead as cancelled when the unknown segment closes", async () => {
    const t0 = new Date("2026-10-28T02:00:00.000Z");
    await seedHistory(t0);
    await createInForceStep(t0, "Prep", 600, 120);
    await runPulseRecorderTick(sql, t0);
    expect((await wakes())[0]).toMatchObject({ status: "pending", last_error: null });
    await tickThrough(t0, at(t0, 60));
    expect((await openSegment())?.state).toBe("off");
    expect((await wakes())[0]).toMatchObject({ status: "dead", last_error: "cancelled" });
  });
});
