import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import {
  issueSnapshotSchema,
  planForecastRequestSchema,
  planForecastResponseSchema,
  type IssueSnapshotObservation
} from "@openrhen/contracts";
import { integrationDatabaseName, processPlanForecastJob } from "@openrhen/database";
import { handleRequest } from "../../../../engine/service/src/server";
import { createSeedState } from "@/state/portal-state";
import { ensureUser, NormalizedPostgresStateStore } from "./state-store";
import { PostgresIssueSnapshotStore } from "./issue-snapshot-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_issue_snapshot");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;
/** Fixed for the run, not for the calendar: the seeded state is read back through real-clock code. */
const fixedNow = new Date();
const engineToken = "integration-issue-snapshot-token";
let sql: postgres.Sql;
let store: NormalizedPostgresStateStore;
let snapshots: PostgresIssueSnapshotStore;
let engineServer: Server;
let engineUrl: string;

async function drainPlanning() {
  for (let index = 0; index < 20; index += 1) {
    const result = await processPlanForecastJob(
      sql,
      { url: engineUrl, token: engineToken, timeoutMs: 10_000 },
      "snapshot-integration-worker"
    );
    if (result === "idle" || result === "retrying" || result === "failed") return;
  }
  throw new Error("Integration planning queue did not drain.");
}

function observation(overrides: Partial<IssueSnapshotObservation> = {}): IssueSnapshotObservation {
  return {
    description: "The recommendation is an action I already finished.",
    observedAt: fixedNow.toISOString(),
    timezone: "Australia/Sydney",
    url: "http://localhost:3000/",
    userAgent: "integration-test",
    viewport: { width: 1280, height: 800 },
    view: {
      mode: "recommendation",
      headline: "Draft the report",
      planningStatus: "current",
      planningDecisionCurrent: true,
      currentEnergy: "high",
      assertedConditions: ["home"],
      countdownSeconds: null,
      session: null,
      primary: { actionId: "action-1", title: "Draft the report", recommendedMinutes: 30 },
      currentDirective: { kind: "action", targetId: "action-1", title: "Draft the report", recommendedMinutes: 30 },
      protectedCommitmentId: null,
      sleepPlanId: null,
      routineStepId: null,
      alternativeActionIds: [],
      evidence: ["Highest ranked eligible action."],
      bannerText: ""
    },
    state: { marker: "client-copy" },
    ...overrides
  };
}

beforeAll(async () => {
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const existing = await admin<
      { exists: boolean }[]
    >`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${testDatabaseName}) AS exists`;
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
  engineServer = createServer(
    (request, response) =>
      void handleRequest(request, response, { token: engineToken, maxPayloadBytes: 5 * 1024 * 1024 })
  );
  await new Promise<void>((resolveListen) => engineServer.listen(0, "127.0.0.1", resolveListen));
  const address = engineServer.address();
  if (!address || typeof address === "string") throw new Error("Integration engine did not bind.");
  engineUrl = `http://127.0.0.1:${address.port}`;
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  store = new NormalizedPostgresStateStore(sql);
  snapshots = new PostgresIssueSnapshotStore(sql);
}, 30_000);

beforeEach(async () => {
  // This suite is allowed to clear only a database whose validated name ends in _test.
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
});

afterAll(async () => {
  await sql?.end();
  await new Promise<void>((resolveClose) => engineServer?.close(() => resolveClose()));
});

describe("issue snapshot capture", () => {
  it("records the engine input and output behind the plan alongside both copies of state", async () => {
    await store.put(createSeedState(fixedNow));
    await drainPlanning();

    const { id, warnings } = await snapshots.capture(observation());
    const stored = await snapshots.get(id);
    expect(stored).not.toBeNull();
    expect(issueSnapshotSchema.safeParse(stored).success).toBe(true);
    expect(stored!.id).toBe(id);
    expect(warnings).toEqual([]);

    // The whole point of the capture: the input the engine was given and the answer it returned are
    // both present, and both still satisfy the contracts, so the moment can be replayed.
    expect(stored!.server.engineRequestSource).toBe("matching_job");
    const request = planForecastRequestSchema.safeParse(stored!.server.engineRequest);
    expect(request.success).toBe(true);
    const result = planForecastResponseSchema.safeParse(stored!.server.planningRun?.result);
    expect(result.success).toBe(true);
    if (request.success && result.success) {
      expect(result.data.inputVersion).toBe(request.data.inputVersion);
      expect(stored!.server.planningRun!.inputVersion).toBe(request.data.inputVersion);
    }

    // Kept apart on purpose: a page rendering state the database has moved past is a real fault.
    expect(stored!.client.state).toEqual({ marker: "client-copy" });
    expect((stored!.server.state as { projects?: unknown[] }).projects?.length).toBeGreaterThan(0);
    expect(stored!.client.view.mode).toBe("recommendation");
    expect(stored!.description).toBe("The recommendation is an action I already finished.");
  });

  it("records the job queue and recent changes without copying whole job payloads", async () => {
    await store.put(createSeedState(fixedNow));
    await drainPlanning();
    const { id } = await snapshots.capture(observation());
    const stored = (await snapshots.get(id))!;

    expect(stored.server.jobs.length).toBeGreaterThan(0);
    for (const job of stored.server.jobs) {
      expect(job.inputVersion).toEqual(expect.any(String));
      expect(job).not.toHaveProperty("payload");
      expect(job).not.toHaveProperty("request");
    }
    expect(JSON.stringify(stored.server.jobs)).not.toContain(engineToken);
    expect(JSON.stringify(stored)).not.toContain(engineToken);
  });

  it("still captures when no plan exists, and says why it cannot be replayed", async () => {
    // No state, so no run and no job: the case where the engine has never produced anything is
    // exactly a bug worth reporting, and it must not be the case that reporting it fails.
    const { id, warnings } = await snapshots.capture(
      observation({ view: { ...observation().view, mode: "nothing_fits", planningStatus: "unavailable" } })
    );
    const stored = (await snapshots.get(id))!;

    expect(issueSnapshotSchema.safeParse(stored).success).toBe(true);
    expect(stored.server.planningRun).toBeNull();
    expect(stored.server.engineRequest).toBeNull();
    expect(stored.server.engineRequestSource).toBe("unavailable");
    expect(warnings).toContain("No current planning run exists for this user.");
    expect(warnings).toContain("No engine input could be recovered. Engine replay is not possible from this snapshot.");
  });

  it("includes a check-in answer in server.changeLog even though no write_rows row exists for it", async () => {
    await store.put(createSeedState(fixedNow));
    await drainPlanning();
    const userId = await ensureUser(sql);
    const answeredAt = new Date();
    const checkInRows = await sql<{ id: string }[]>`
      INSERT INTO check_in (user_id, slot_at, directive_kind, directive_title, status, answered_at)
      VALUES (${userId}, ${answeredAt}, 'action', 'Write the report', 'on_track', ${answeredAt})
      RETURNING id
    `;
    const checkInId = checkInRows[0]!.id;
    const changeLogForAnswer = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM write_rows WHERE entity_id=${checkInId}`;
    expect(changeLogForAnswer[0]!.count).toBe(0);

    const { id } = await snapshots.capture(observation());
    const stored = (await snapshots.get(id))!;

    const answerEntry = stored.server.changeLog.find(
      (entry) => (entry as { entityId?: string }).entityId === checkInId
    ) as Record<string, unknown> | undefined;
    expect(answerEntry).toMatchObject({
      entityType: "check_in",
      entityId: checkInId,
      operation: "answer",
      status: "on_track",
      source: "check_in",
      createdAt: answeredAt.toISOString()
    });
  });

  it("lists captures newest first with the metadata the list view needs", async () => {
    await store.put(createSeedState(fixedNow));
    await drainPlanning();
    const first = await snapshots.capture(observation({ description: "first" }));
    const second = await snapshots.capture(observation({ description: "second" }));

    const listed = await snapshots.list();
    expect(listed.map((item) => item.id)).toEqual([second.id, first.id]);
    expect(listed[0]).toMatchObject({ description: "second", mode: "recommendation", planningStatus: "current" });
    expect(listed[0]!.sizeBytes).toBeGreaterThan(0);
    expect(listed[0]!.engineInputVersion).toEqual(expect.any(String));
    expect(listed[0]!.reviewedAt).toBeNull();
    expect(listed[0]!.reviewNote).toBeNull();
  });
});

describe("issue snapshot review", () => {
  it("records the verdict and the account of what was done", async () => {
    const { id } = await snapshots.capture(observation());
    const reviewed = await snapshots.review(id, {
      reviewed: true,
      note: "Dropped the 15-hour lead on the flexible steps."
    });

    expect(reviewed?.reviewedAt).toEqual(expect.any(String));
    expect(reviewed?.reviewNote).toBe("Dropped the 15-hour lead on the flexible steps.");
  });

  it("leaves the captured evidence untouched, so a reviewed report still replays as reported", async () => {
    await store.put(createSeedState(fixedNow));
    await drainPlanning();
    const { id } = await snapshots.capture(observation());
    const before = await snapshots.get(id);

    await snapshots.review(id, { reviewed: true, note: "fixed" });
    const after = await snapshots.get(id);

    // This is what makes closing a report safe: the verdict is a separate column, never an edit to
    // the evidence. A snapshot closed a year ago must still reproduce the moment it captured.
    expect(after).toEqual(before);
    expect(issueSnapshotSchema.safeParse(after).success).toBe(true);
    expect(planForecastRequestSchema.safeParse(after!.server.engineRequest).success).toBe(true);
  });

  it("sorts outstanding reports ahead of reviewed ones so the list is a work queue", async () => {
    await snapshots.capture(observation({ description: "older, still open" }));
    const newer = await snapshots.capture(observation({ description: "newer, will be closed" }));
    await snapshots.review(newer.id, { reviewed: true });

    const listed = await snapshots.list();
    expect(listed.map((item) => item.description)).toEqual(["older, still open", "newer, will be closed"]);
  });

  it("reopens a report closed too early and drops the stale note", async () => {
    const { id } = await snapshots.capture(observation());
    await snapshots.review(id, { reviewed: true, note: "thought this was fixed" });
    const reopened = await snapshots.review(id, { reviewed: false });

    expect(reopened?.reviewedAt).toBeNull();
    expect(reopened?.reviewNote).toBeNull();
    expect((await snapshots.list())[0]!.id).toBe(id);
  });

  it("reports an unknown snapshot rather than silently succeeding", async () => {
    expect(await snapshots.review("00000000-0000-4000-8000-000000000000", { reviewed: true })).toBeNull();
  });
});
