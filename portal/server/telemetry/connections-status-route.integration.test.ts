import "@/test/example-calendar-sources";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { GET as connectionsStatusGet, POST as connectionsStatus } from "@/app/api/connections/status/route";

/**
 * `provider_call_telemetry` has no scheduled worker of its own — its 7-day retention runs only when
 * something calls `pruneOldProviderTelemetry`. That used to be buried inside `getProviderStatus`,
 * invisible from outside and called once per provider per request; it now happens once per request in
 * the route itself. This proves the thing a person actually hits — `POST /api/connections/status` — is
 * the real production trigger, not just the bare prune function in isolation.
 *
 * The route is `POST`, not `GET` (finding 32): a "check now" click can dispatch a live probe or
 * trigger a real, billable Google travel-matrix refresh, so a prefetching browser or crawler must not
 * be able to cause that just by following a `GET` link. `GET` now answers 405.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_connections_status");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

/** A stale row of no particular kind — its only job is to exist and then be gone. */
async function insertStaleRow(provider: string, daysAgo: number) {
  const startedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await sql`
    INSERT INTO provider_call_telemetry (provider, operation, kind, started_at, ok)
    VALUES (${provider}, ${"reachability_probe"}, ${"probe"}, ${startedAt.toISOString()}, ${true})
  `;
}

/**
 * A recent successful real call — inside the passive-reachability window — so `getProviderStatus`
 * finds recent evidence and never dispatches a probe. Without this, checking a provider whose
 * telemetry was just pruned away would itself insert a fresh probe row, which would make "how many
 * rows are left" the wrong thing to assert about pruning specifically.
 */
async function insertRecentRealCall(provider: string) {
  await sql`
    INSERT INTO provider_call_telemetry (provider, operation, kind, started_at, ok)
    VALUES (${provider}, ${"travel_matrix"}, ${"real_call"}, now(), ${true})
  `;
}

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false, prepare: true });
  process.env.DATABASE_URL = testUrl.toString();
  // Deterministic and hermetic: the reachability question is covered elsewhere, so the sidecar is
  // left unconfigured here and every probe just answers "not configured" without a network call.
  delete process.env.OUTBOUND_PROXY_URL;
  delete process.env.OUTBOUND_PROXY_TOKEN;
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE provider_call_telemetry");
});

afterAll(async () => {
  await sql?.end();
});

describe("POST /api/connections/status", () => {
  it("prunes telemetry rows past the 7-day retention window as a side effect of being read", async () => {
    await insertStaleRow("openai", 8);
    await insertRecentRealCall("openai"); // keeps getProviderStatus passive — no probe row added

    const response = await connectionsStatus(
      new Request("http://localhost/api/connections/status?provider=openai", { method: "POST" }),
      undefined
    );
    expect(response.status).toBe(200);

    const rows = await sql<{ kind: string }[]>`SELECT kind FROM provider_call_telemetry WHERE provider = 'openai'`;
    // Only the recent real call survives; the request itself did the pruning, and nothing else was
    // recorded, because that recent call was already enough to answer reachability passively.
    expect(rows).toEqual([{ kind: "real_call" }]);
  });

  it("prunes the whole table, not just the provider that was asked about", async () => {
    // Nothing here is for 'openai', the provider this request actually names — proving prune runs
    // unconditionally on every read rather than being scoped to whatever the caller asked about.
    await insertStaleRow("google", 8);
    await insertStaleRow("example_shared", 8);
    await insertRecentRealCall("google");
    await insertRecentRealCall("example_shared");
    await insertRecentRealCall("openai");

    const response = await connectionsStatus(
      new Request("http://localhost/api/connections/status?provider=openai", { method: "POST" }),
      undefined
    );
    expect(response.status).toBe(200);

    const rows = await sql<{ provider: string; kind: string }[]>`SELECT provider, kind FROM provider_call_telemetry`;
    // The two stale rows are gone; every recent real call — including the ones for providers this
    // request never asked about — survives untouched.
    expect(rows.every((row) => row.kind === "real_call")).toBe(true);
    expect(rows.map((row) => row.provider).sort()).toEqual(["example_shared", "google", "openai"]);
  });
});

describe("GET /api/connections/status", () => {
  it("refuses with 405 and an Allow: POST header, since a GET must never trigger a live or billable check", async () => {
    const response = await connectionsStatusGet(new Request("http://localhost/api/connections/status"), undefined);
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("POST");
  });
});
