import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import { config } from "dotenv";
import { resolve } from "node:path";
import postgres from "postgres";
import { assertTestDatabaseUrl } from "./test-database-guard.js";

config({ path: resolve(process.cwd(), "../../.env"), quiet: true });

/**
 * Seeds the disposable test database with a "running late" scenario for
 * `scripts/smoke/production-click.mjs`'s end-to-end check that the Now page's compact late-commitment
 * banner (`portal/features/now/components/late-commitment-banner.tsx`) actually renders in a real
 * production build, not just in a jsdom unit test — the class of bug (page composition, not model or
 * scheduler logic) that `app/now-page.test.tsx` cannot catch on its own.
 *
 * Seeds directly into `commitments` / `routine_steps` / `sessions` (a confirmed,
 * located commitment whose start has passed with a pending before-phase routine step, and a session
 * running against a *different* commitment) and writes a matching `planning_runs` row by hand rather
 * than driving the real Plan and Forecast Engine end to end: that would additionally require standing
 * up `@openrhen/engine-service` and `@openrhen/engine-worker` as live processes and waiting for a
 * queued job to clear, which is a much larger, flakier undertaking than this smoke script's existing
 * "start the production server, load the page" shape. `portal/server/persistence/postgres/readers/planning-status.ts` reads `planning_runs.result`
 * verbatim (see `portal/features/planning/planning-runtime.ts`), and `resolveNowActivity`'s
 * `protectedInfo` admits a `protectedCommitment` on nothing more than a matching confirmed row in
 * `state.commitments` (`platform/contracts/src/planning/now-activity.ts`), so this seed reaches exactly the same portal
 * code path a genuine engine-computed "late" verdict would, without asserting anything about whether
 * the *engine itself* would call this commitment late — that is `engine/core`'s own test suite's job,
 * not this smoke's.
 *
 * Idempotent under deterministic ids: every row this script owns is upserted by a fixed uuid, so
 * re-running it (as `production-click.mjs` does on every smoke run) never accumulates duplicates.
 */

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
// Stops the owner's real running session and replaces the current plan, so only ever a `_test` database.
assertTestDatabaseUrl(databaseUrl);

const LOCATION_ID = "smoke-late-location";
const LATE_COMMITMENT_ID = "1a2b3c4d-0000-4000-8000-000000000001";
const OTHER_COMMITMENT_ID = "1a2b3c4d-0000-4000-8000-000000000002";
const ROUTINE_STEP_ID = "1a2b3c4d-0000-4000-8000-000000000003";
const SESSION_ID = "1a2b3c4d-0000-4000-8000-000000000004";
const PLANNING_RUN_ID = "1a2b3c4d-0000-4000-8000-000000000005";
const REQUEST_ID = "1a2b3c4d-0000-4000-8000-000000000006";
const LATE_COMMITMENT_TITLE = "Smoke: dentist appointment";

const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });

try {
  const now = new Date();

  const users = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
  let userId = users[0]?.id;
  if (!userId) {
    const created = await sql<{ id: string }[]>`
      INSERT INTO users (display_name, timezone) VALUES ('Smoke Test User', ${DEFAULT_TIMEZONE}) RETURNING id
    `;
    userId = created[0]!.id;
  }

  await sql`
    INSERT INTO condition_definitions (user_id, id, name, kind)
    VALUES (${userId}, ${LOCATION_ID}, 'Smoke Test Dentist', 'location')
    ON CONFLICT (user_id, id) DO UPDATE SET name = EXCLUDED.name, status = 'active'
  `;

  // Started fifteen minutes ago, still running for another forty-five — the clock alone would call
  // this "active", which is exactly what makes the still-pending routine step below the reason it is
  // "late" rather than merely "in progress".
  const lateStartsAt = new Date(now.getTime() - 15 * 60_000);
  const lateEndsAt = new Date(now.getTime() + 45 * 60_000);
  await sql`
    INSERT INTO commitments (
      id, user_id, title, starts_at, ends_at, status, location_id, setup_before_minutes
    )
    VALUES (
      ${LATE_COMMITMENT_ID}, ${userId}, ${LATE_COMMITMENT_TITLE}, ${lateStartsAt}, ${lateEndsAt},
      'confirmed', ${LOCATION_ID}, 15
    )
    ON CONFLICT (id) DO UPDATE SET
      starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, status = 'confirmed'
  `;
  await sql`
    INSERT INTO routine_steps (
      id, user_id, commitment_id, anchor_type, anchor_id, title, duration_minutes, sequence, timing_rule, phase, status
    )
    VALUES (
      ${ROUTINE_STEP_ID}, ${userId}, ${LATE_COMMITMENT_ID}, 'commitment', ${LATE_COMMITMENT_ID}, 'Pack referral letter', 10, 1,
      'contiguous', 'before', 'pending'
    )
    ON CONFLICT (id) DO UPDATE SET status = 'pending'
  `;

  // Unrelated to the late commitment above — a session running against this one must never be read as
  // evidence the late commitment is being handled.
  const otherStartsAt = new Date(now.getTime() - 5 * 60_000);
  const otherEndsAt = new Date(now.getTime() + 55 * 60_000);
  await sql`
    INSERT INTO commitments (id, user_id, title, starts_at, ends_at, status)
    VALUES (${OTHER_COMMITMENT_ID}, ${userId}, 'Smoke: unrelated meeting', ${otherStartsAt}, ${otherEndsAt}, 'confirmed')
    ON CONFLICT (id) DO UPDATE SET starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at, status = 'confirmed'
  `;
  // Only one 'running' session per user is allowed (`sessions_one_running_per_user`), so any other
  // running session — this script's own from a previous run included — has to step aside first.
  await sql`
    UPDATE sessions SET status = 'stopped', ended_at = ${now}
    WHERE user_id = ${userId} AND status = 'running' AND id <> ${SESSION_ID}
  `;
  await sql`
    INSERT INTO sessions (
      id, user_id, target_type, target_id, target_title, status,
      planned_started_at, planned_end_at, started_at, planned_minutes, remaining_before_minutes
    )
    VALUES (
      ${SESSION_ID}, ${userId}, 'fixed_commitment', ${OTHER_COMMITMENT_ID}, 'Smoke: unrelated meeting',
      'running', ${otherStartsAt}, ${new Date(now.getTime() + 10 * 60_000)}, ${new Date(now.getTime() - 5 * 60_000)},
      15, 90
    )
    ON CONFLICT (id) DO UPDATE SET
      status = 'running', ended_at = NULL, planned_started_at = EXCLUDED.planned_started_at,
      planned_end_at = EXCLUDED.planned_end_at, started_at = EXCLUDED.started_at
  `;

  const result = {
    contractVersion: "1",
    requestId: REQUEST_ID,
    inputVersion: "smoke-late-commitment-v1",
    engineVersion: "smoke-test",
    calculatedAt: now.toISOString(),
    validUntil: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
    derivedState: {
      sleepPlans: [],
      occurrences: [],
      routineSteps: [],
      commitmentRepeats: []
    },
    // Not `{}`: the portal's own hydration (`hydrateJson(...) ?? EMPTY_SCHEDULE`,
    // `portal/state/portal-provider.tsx`) only falls back to its empty default on a genuinely absent
    // `schedule`, not a present-but-empty object — an empty object hydrates to itself, missing the
    // `slots` array the Today page reads unconditionally (`slots.filter(...)`) and crashes on. The real
    // engine always populates this fully; this is the smallest shape that satisfies every reader.
    schedule: { slots: [], forecasts: [], capacityEnvelopes: [], projectEnvelopes: [] },
    recommendation: {
      primary: null,
      alternatives: [],
      candidates: [],
      headline: `Running late for ${LATE_COMMITMENT_TITLE}`,
      explanation: "Preparation is behind and the commitment has already started.",
      evidence: [],
      protectedCommitment: {
        id: LATE_COMMITMENT_ID,
        title: LATE_COMMITMENT_TITLE,
        phase: "setup",
        startsAt: lateStartsAt.toISOString(),
        endsAt: lateEndsAt.toISOString(),
        protectedStartAt: lateStartsAt.toISOString(),
        protectedEndAt: lateEndsAt.toISOString(),
        phaseStartsAt: lateStartsAt.toISOString(),
        phaseEndsAt: lateEndsAt.toISOString(),
        late: true
      }
    },
    currentDirective: { kind: "none", title: "No suitable action", recommendedMinutes: 0 },
    upcomingDirectives: [],
    continuation: null
  };

  // At most one non-superseded run per user (`planning_runs_current_user_unique`) — supersede whatever
  // is there (this script's own prior row included) before writing the fresh one.
  await sql`
    UPDATE planning_runs SET superseded_at = ${now} WHERE user_id = ${userId} AND superseded_at IS NULL
  `;
  await sql`
    INSERT INTO planning_runs (
      id, user_id, request_id, input_version, contract_version, engine_version, calculated_at, valid_until, result
    )
    VALUES (
      ${PLANNING_RUN_ID}, ${userId}, ${REQUEST_ID}, ${result.inputVersion}, ${result.contractVersion},
      ${result.engineVersion}, ${new Date(result.calculatedAt)}, ${new Date(result.validUntil)}, ${sql.json(result as never)}
    )
    ON CONFLICT (id) DO UPDATE SET
      calculated_at = EXCLUDED.calculated_at, valid_until = EXCLUDED.valid_until, result = EXCLUDED.result,
      superseded_at = NULL
  `;

  console.log(`Seeded a late commitment ("${LATE_COMMITMENT_TITLE}") and an unrelated running session for smoke.`);
} finally {
  await sql.end();
}
