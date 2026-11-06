import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { integrationDatabaseName } from "@openrhen/database";
import type { DoctorItem, DoctorReport } from "@openrhen/contracts";
import { runAttentionWake } from "./attention-wake";
import { resetAttentionCountsMemo } from "./counts";
import type { AttentionReaders } from "./readers";

/** The waiting-attention wake over a real database: the rise from 0 queues one wake, and only one an hour. */
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(
  process.env.ATTENTION_WAKE_TEST_DATABASE_NAME,
  "openrhen_attention_wake"
);
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("ATTENTION_WAKE_TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
const T0 = new Date("2026-11-05T01:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

const blocking: DoctorItem = {
  id: "sync_failing:x",
  check: "sync_failing",
  tier: "blocking",
  area: "integrations",
  title: "t",
  why: "w",
  handles: [],
  fix: { who: "person", question: "q" }
};
const report = (items: DoctorItem[]): DoctorReport => ({
  generatedAt: T0.toISOString(),
  healthy: items.length === 0,
  counts: { blocking: items.length, degrading: 0, tidy: 0 },
  byArea: {},
  items,
  notChecked: []
});
const settled = { due: false, lapsed: false, pulse: null, since: null, unsettled: 0 };

function readers(state: { blocking: number; catchUp: boolean; entriesFail?: boolean; checkIn?: boolean }) {
  return {
    userId: vi.fn(async () => "unused"),
    doctor: vi.fn(async () => report(Array.from({ length: state.blocking }, () => blocking))),
    decided: vi.fn(async () => 0),
    entries: vi.fn(async () => {
      if (state.entriesFail) throw new Error("down");
      return state.checkIn ? [{ id: "check-in:1", kind: "check_in", plannedAt: T0.toISOString() }] : [];
    }),
    due: vi.fn(async () => ({ ...settled, due: state.catchUp })),
    pulse: vi.fn(),
    refusal: vi.fn(),
    proposals: vi.fn()
  } as unknown as AttentionReaders;
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabaseName} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${testDatabaseName}`);
  await admin.end();
  sql = postgres(testUrl.toString(), { max: 4 });
  await migrate(drizzle(sql), {
    migrationsFolder: fileURLToPath(new URL("../../../platform/database/drizzle", import.meta.url))
  });
});

beforeEach(async () => {
  resetAttentionCountsMemo();
  vi.spyOn(console, "error").mockImplementation(() => {});
  await sql`TRUNCATE agent_wakes`;
  await sql`DELETE FROM pulse_segments`;
});

afterAll(async () => {
  await sql?.end();
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${testDatabaseName} WITH (FORCE)`);
  await admin.end();
});

const wakes = () => sql<{ status: string }[]>`SELECT status FROM agent_wakes WHERE event = 'attention_waiting'`;

describe("runAttentionWake", () => {
  it("queues nothing while nothing waits, then one wake when a blocking item or a due catch-up appears", async () => {
    expect(
      await runAttentionWake(sql as never, { now: at(0), readers: readers({ blocking: 0, catchUp: false }) })
    ).toBe("idle");
    expect(await wakes()).toHaveLength(0);
    resetAttentionCountsMemo();
    expect(await runAttentionWake(sql as never, { now: at(1), readers: readers({ blocking: 0, catchUp: true }) })).toBe(
      "enqueued"
    );
    resetAttentionCountsMemo();
    expect(await runAttentionWake(sql as never, { now: at(2), readers: readers({ blocking: 3, catchUp: true }) })).toBe(
      "capped"
    );
    expect(await wakes()).toEqual([{ status: "pending" }]);
  });

  it("does not count an open check-in, which has its own wake", async () => {
    expect(
      await runAttentionWake(sql as never, {
        now: at(0),
        readers: readers({ blocking: 0, catchUp: false, checkIn: true })
      })
    ).toBe("idle");
    expect(await wakes()).toHaveLength(0);
  });

  it("neither wakes nor closes the episode when a source could not be read and nothing else waits", async () => {
    await runAttentionWake(sql as never, { now: at(0), readers: readers({ blocking: 1, catchUp: false }) });
    resetAttentionCountsMemo();
    expect(
      await runAttentionWake(sql as never, {
        now: at(5),
        readers: readers({ blocking: 0, catchUp: false, entriesFail: true })
      })
    ).toBe("idle");
    resetAttentionCountsMemo();
    // Still the same episode: the unique key was not released.
    expect(
      await runAttentionWake(sql as never, { now: at(90), readers: readers({ blocking: 1, catchUp: false }) })
    ).toBe("open");
  });

  it("holds the wake while the owner is asleep", async () => {
    // ensureUser creates the user on first use; run one idle tick first so a row exists to hang the segment on.
    await runAttentionWake(sql as never, { now: at(0), readers: readers({ blocking: 0, catchUp: false }) });
    await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason)
      SELECT id, ${T0.toISOString()}::timestamptz, 'asleep', 'asleep' FROM users LIMIT 1`;
    resetAttentionCountsMemo();
    expect(
      await runAttentionWake(sql as never, { now: at(1), readers: readers({ blocking: 1, catchUp: false }) })
    ).toBe("asleep");
  });
});
