import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import type { PublicPulseV1, PulsePublishResult } from "@openrhen/contracts";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "../persistence/postgres/ensure-user";
import { runPulseRecorderTick } from "./pulse-recorder";
import { runPulsePublisher } from "./pulse-publisher";

/**
 * The pulse criteria and publish design note, "Publish" and its Testing section: sends on change,
 * not on share drift; the 15-minute heartbeat; disabled sends nothing. Self-contained `_test`
 * database, the same pattern as `pulse-recorder.integration.test.ts`.
 */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.PULSE_PUBLISHER_TEST_DATABASE_NAME,
  "openrhen_pulse_publisher"
);

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("PULSE_PUBLISHER_TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

async function enablePublishing() {
  await sql`UPDATE user_preferences SET pulse_publish_enabled=true WHERE user_id=${userId}`;
}

/**
 * Runs a recorder tick at `now` without tripping the outage-gap rule (`pulse-recorder.ts`'s own
 * 5-minute threshold, covered by `pulse-recorder.integration.test.ts`) — these tests jump the clock
 * by more than 5 minutes in one step to reach the publisher's 15-minute heartbeat, which is not the
 * same silence a real outage would be, so the bookkeeping is nudged forward first.
 */
async function tickWithoutGap(now: Date) {
  await sql`UPDATE pulse_state SET last_evaluated_at=${new Date(now.getTime() - 1000)} WHERE user_id=${userId}`;
  await runPulseRecorderTick(sql, now);
}

function stubPublish(outcome: PulsePublishResult["outcome"]): {
  calls: PublicPulseV1[];
  publish: (pulse: PublicPulseV1) => Promise<PulsePublishResult>;
} {
  const calls: PublicPulseV1[] = [];
  return {
    calls,
    publish: async (pulse: PublicPulseV1) => {
      calls.push(pulse);
      return { outcome };
    }
  };
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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: true, prepare: true });
  userId = await ensureUser(sql);
}, 30_000);

beforeEach(async () => {
  await sql.unsafe(
    "TRUNCATE TABLE pulse_segments, pulse_state, check_in, session_segments, sessions, routine_steps, commitments RESTART IDENTITY CASCADE"
  );
  await sql`UPDATE user_preferences SET pulse_publish_enabled=false WHERE user_id=${userId}`;
});

afterAll(async () => {
  await sql?.end();
});

describe("disabled", () => {
  it("sends nothing and queues nothing when publishing is off", async () => {
    const now = new Date();
    await runPulseRecorderTick(sql, now);
    const { calls, publish } = stubPublish("delivered");
    const outcome = await runPulsePublisher(sql, userId, now, publish);
    expect(outcome).toEqual({ status: "skipped", reason: "disabled" });
    expect(calls).toHaveLength(0);
  });
});

describe("not yet evaluated", () => {
  it("skips when the recorder has never run for this user", async () => {
    await enablePublishing();
    const { publish } = stubPublish("delivered");
    const outcome = await runPulsePublisher(sql, userId, new Date(), publish);
    expect(outcome).toEqual({ status: "skipped", reason: "not_evaluated" });
  });
});

describe("sends on change, not on share drift", () => {
  it("publishes on the first evaluation, then skips an unchanged re-evaluation", async () => {
    await enablePublishing();
    const t0 = new Date();
    await runPulseRecorderTick(sql, t0);
    const first = stubPublish("delivered");
    const firstOutcome = await runPulsePublisher(sql, userId, t0, first.publish);
    expect(firstOutcome).toEqual({ status: "sent", outcome: "delivered" });
    expect(first.calls).toHaveLength(1);

    // A little later, nothing about the judgement changed (still "free"): the object's shares may
    // have drifted (minutes counted), but that alone must not trigger a resend.
    const t1 = new Date(t0.getTime() + 30_000);
    await runPulseRecorderTick(sql, t1);
    const second = stubPublish("delivered");
    const secondOutcome = await runPulsePublisher(sql, userId, t1, second.publish);
    expect(secondOutcome).toEqual({ status: "skipped", reason: "unchanged" });
    expect(second.calls).toHaveLength(0);
  });

  it("increments seq on each actual send", async () => {
    await enablePublishing();
    const t0 = new Date();
    await runPulseRecorderTick(sql, t0);
    const first = stubPublish("delivered");
    await runPulsePublisher(sql, userId, t0, first.publish);
    expect(first.calls[0]!.seq).toBe(1);

    // Force a resend via the heartbeat rather than a real state change, to isolate seq incrementing
    // from judgement changes.
    const t1 = new Date(t0.getTime() + 16 * 60_000);
    await tickWithoutGap(t1);
    const second = stubPublish("delivered");
    await runPulsePublisher(sql, userId, t1, second.publish);
    expect(second.calls[0]!.seq).toBe(2);
  });
});

describe("heartbeat", () => {
  it("resends unchanged content after 15 minutes", async () => {
    await enablePublishing();
    const t0 = new Date();
    await runPulseRecorderTick(sql, t0);
    await runPulsePublisher(sql, userId, t0, stubPublish("delivered").publish);

    const justUnder = new Date(t0.getTime() + 14 * 60_000);
    await tickWithoutGap(justUnder);
    const early = stubPublish("delivered");
    expect(await runPulsePublisher(sql, userId, justUnder, early.publish)).toEqual({
      status: "skipped",
      reason: "unchanged"
    });

    const after = new Date(t0.getTime() + 15 * 60_000 + 1000);
    await tickWithoutGap(after);
    const late = stubPublish("delivered");
    expect(await runPulsePublisher(sql, userId, after, late.publish)).toEqual({ status: "sent", outcome: "delivered" });
    expect(late.calls).toHaveLength(1);
  });
});

describe("failure retries on the very next tick", () => {
  it("does not wait for the heartbeat after a failed send", async () => {
    await enablePublishing();
    const t0 = new Date();
    await runPulseRecorderTick(sql, t0);
    const failing = stubPublish("failed");
    expect(await runPulsePublisher(sql, userId, t0, failing.publish)).toEqual({ status: "sent", outcome: "failed" });

    // Seconds later, nothing changed — but the last attempt failed, so this must retry immediately
    // rather than skip as "unchanged".
    const t1 = new Date(t0.getTime() + 5_000);
    await runPulseRecorderTick(sql, t1);
    const retry = stubPublish("delivered");
    expect(await runPulsePublisher(sql, userId, t1, retry.publish)).toEqual({ status: "sent", outcome: "delivered" });
    expect(retry.calls).toHaveLength(1);
  });
});
