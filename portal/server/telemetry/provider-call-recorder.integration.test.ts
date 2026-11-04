import "@/test/example-calendar-sources";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import {
  AVERAGE_WINDOW_HOURS,
  REACHABILITY_WINDOW_MS,
  getProviderStatus,
  pruneOldProviderTelemetry,
  recordProviderCall,
  recordProviderProbe,
  recordStreamingProviderCall,
  type CallOutcome,
  type ReachabilityCheck
} from "./provider-call-recorder";

/** Wraps a bare probe function as the ordinary `ReachabilityCheck` shape most of these tests use. */
function probeCheck(run: () => Promise<CallOutcome>): ReachabilityCheck {
  return { kind: "probe", run };
}

/**
 * Everything here that matters — the passive-reachability window, the probe rate limit, and the 24h
 * averages — is a read against real rows in real time, so it runs against a migrated database rather
 * than a mocked `sql` tag. Rows land with `started_at` set explicitly (never `defaultNow()`), which is
 * what lets a test place a row "6 minutes ago" or "8 days ago" without waiting for the clock.
 */

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_provider_call_recorder");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;

async function insertRow(row: {
  provider?: string;
  operation?: string;
  kind?: "real_call" | "probe";
  minutesAgo: number;
  firstByteMs?: number | null;
  totalMs?: number | null;
  ok?: boolean;
  errorSummary?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}) {
  const startedAt = new Date(Date.now() - row.minutesAgo * 60_000);
  await sql`
    INSERT INTO provider_call_telemetry
      (provider, operation, kind, started_at, first_byte_ms, total_ms, ok, error_summary, input_tokens, output_tokens)
    VALUES (
      ${row.provider ?? "openai"}, ${row.operation ?? "extract_contract"}, ${row.kind ?? "real_call"},
      ${startedAt.toISOString()}, ${row.firstByteMs ?? null}, ${row.totalMs ?? null}, ${row.ok ?? true},
      ${row.errorSummary ?? null}, ${row.inputTokens ?? null}, ${row.outputTokens ?? null}
    )
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
  // The recorder reads DATABASE_URL from the process environment at call time.
  process.env.DATABASE_URL = testUrl.toString();
}, 30_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE provider_call_telemetry");
});

afterAll(async () => {
  await sql?.end();
});

describe("recordProviderCall", () => {
  it("records a successful real call with total time and no token columns when none are classified", async () => {
    const result = await recordProviderCall("google", "geocode", async () => "matches");
    expect(result).toBe("matches");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'google'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation: "geocode", kind: "real_call", ok: true, first_byte_ms: null });
    expect(rows[0]!.total_ms).toBeGreaterThanOrEqual(0);
  });

  it("records a failure and rethrows when the call throws", async () => {
    await expect(
      recordProviderCall("google", "travel_matrix", async () => {
        throw new Error("Routes request failed with 500");
      })
    ).rejects.toThrow("Routes request failed with 500");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'google'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: false, error_summary: "Routes request failed with 500" });
  });

  it("uses the classify function to judge a domain failure that did not throw", async () => {
    const result = await recordProviderCall(
      "example_shared",
      "proof",
      async () => ({ status: "failed" as const, message: "Example Shared is rate-limiting requests." }),
      (value) => (value.status === "failed" ? { ok: false, detail: value.message } : { ok: true })
    );
    expect(result.status).toBe("failed");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'example_shared'`;
    expect(rows[0]).toMatchObject({ ok: false, error_summary: "Example Shared is rate-limiting requests." });
  });

  it("carries input and output tokens through to the row when classify reports them", async () => {
    await recordProviderCall(
      "openai",
      "extract_contract",
      async () => ({ usage: { input_tokens: 812, output_tokens: 140 } }),
      (value) => ({ ok: true, inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens })
    );
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'openai'`;
    expect(rows[0]).toMatchObject({ input_tokens: 812, output_tokens: 140 });
  });
});

describe("recordStreamingProviderCall", () => {
  it("records first-byte time separately from total time, counting only the first mark", async () => {
    const result = await recordStreamingProviderCall("openai", "deliverable_chat", async (markFirstByte) => {
      await new Promise((r) => setTimeout(r, 15));
      markFirstByte();
      await new Promise((r) => setTimeout(r, 15));
      markFirstByte(); // A second delta arriving later must not move first-byte time.
      return "the full reply";
    });
    expect(result).toBe("the full reply");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'openai'`;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.first_byte_ms).toBeGreaterThanOrEqual(10);
    expect(row.total_ms as number).toBeGreaterThanOrEqual(row.first_byte_ms as number);
  });

  it("records a null first-byte time when the stream fails before any delta arrives", async () => {
    await expect(
      recordStreamingProviderCall("openai", "deliverable_chat", async () => {
        throw new Error("The assistant stream ended early.");
      })
    ).rejects.toThrow();
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'openai'`;
    expect(rows[0]).toMatchObject({ ok: false, first_byte_ms: null });
  });
});

describe("getProviderStatus — passive-first reachability", () => {
  it("treats a recent successful real call as reachable and does not probe", async () => {
    await insertRow({ provider: "google", kind: "real_call", ok: true, minutesAgo: 1, totalMs: 240 });
    let probed = false;
    const status = await getProviderStatus(
      "google",
      probeCheck(async () => {
        probed = true;
        return { ok: true };
      })
    );
    expect(probed).toBe(false);
    expect(status.reachable).toBe(true);
    expect(status.source).toBe("real_call");
    expect(status.rateLimited).toBe(false);
  });

  it("does not count a real call outside the reachability window as proof, and probes instead", async () => {
    const outsideMinutes = REACHABILITY_WINDOW_MS / 60_000 + 1;
    await insertRow({ provider: "google", kind: "real_call", ok: true, minutesAgo: outsideMinutes, totalMs: 240 });
    let probed = false;
    const status = await getProviderStatus(
      "google",
      probeCheck(async () => {
        probed = true;
        return { ok: true };
      })
    );
    expect(probed).toBe(true);
    expect(status.source).toBe("probe");
  });

  it("probes when nothing has ever been recorded, and records the probe", async () => {
    let probeCalls = 0;
    const status = await getProviderStatus(
      "example_shared",
      probeCheck(async () => {
        probeCalls += 1;
        return { ok: true };
      })
    );
    expect(probeCalls).toBe(1);
    expect(status.reachable).toBe(true);
    expect(status.source).toBe("probe");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'example_shared' AND kind = 'probe'`;
    expect(rows).toHaveLength(1);
  });

  it("reports a provider that is not set up as not_configured, not failed, and records nothing", async () => {
    const status = await getProviderStatus(
      "example_shared",
      probeCheck(async () => ({
        ok: false,
        notConfigured: true,
        detail: "Example Shared is not configured: EXAMPLE_SHARED_EMAIL."
      }))
    );
    expect(status.reachable).toBeNull();
    expect(status.source).toBe("not_configured");
    expect(status.detail).toBe("Example Shared is not configured: EXAMPLE_SHARED_EMAIL.");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'example_shared'`;
    expect(rows).toHaveLength(0);
  });

  it("reuses a probe from inside the rate-limit window instead of probing again", async () => {
    await insertRow({ provider: "example_shared", kind: "probe", ok: false, minutesAgo: 1, totalMs: 300 });
    let probed = false;
    const status = await getProviderStatus(
      "example_shared",
      probeCheck(async () => {
        probed = true;
        return { ok: true };
      })
    );
    expect(probed).toBe(false);
    expect(status.reachable).toBe(false);
    expect(status.source).toBe("probe");
    expect(status.rateLimited).toBe(true);
  });

  it("probes again once a stale probe has aged out of the window", async () => {
    const outsideMinutes = REACHABILITY_WINDOW_MS / 60_000 + 1;
    await insertRow({ provider: "example_shared", kind: "probe", ok: false, minutesAgo: outsideMinutes, totalMs: 300 });
    let probed = false;
    const status = await getProviderStatus(
      "example_shared",
      probeCheck(async () => {
        probed = true;
        return { ok: true };
      })
    );
    expect(probed).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.rateLimited).toBe(false);
  });

  it("reports skipped reachability without probing when the self-recording check has nothing to do", async () => {
    let called = false;
    const status = await getProviderStatus("google", {
      kind: "self_recording",
      run: async () => {
        called = true;
        return { status: "skipped", detail: "No recent traffic, nothing to refresh: no located commitment is stale." };
      }
    });
    expect(called).toBe(true);
    expect(status.reachable).toBeNull();
    expect(status.source).toBe("skipped");
    expect(status.checkedAt).toBeNull();
    expect(status.detail).toContain("nothing to refresh");
    expect(status.rateLimited).toBe(false);
    // Nothing was recorded: a skip makes no provider request at all.
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'google'`;
    expect(rows).toHaveLength(0);
  });

  it("reads back a self-recording check's own outcome without double-recording it", async () => {
    // Simulates google-travel-probe.ts: the check itself already wrote a real_call row (e.g. via
    // fetchTravelMatrix's own recordProviderCall) before getProviderStatus ever sees the result.
    const status = await getProviderStatus("google", {
      kind: "self_recording",
      run: async () => {
        await insertRow({ provider: "google", operation: "travel_matrix", ok: true, minutesAgo: 0 });
        return { status: "checked", ok: true };
      }
    });
    expect(status.reachable).toBe(true);
    expect(status.source).toBe("real_call");
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'google'`;
    // Exactly the one row the check itself wrote — getProviderStatus recorded nothing further.
    expect(rows).toHaveLength(1);
  });
});

describe("getProviderStatus — averages, counts and last call", () => {
  it("excludes probe rows from the latency averages and the call-type counts", async () => {
    await insertRow({ provider: "openai", operation: "extract_contract", totalMs: 2000, minutesAgo: 5 });
    // A cheap reachability probe (e.g. OpenAI's model listing) is a different, much faster operation —
    // folding it into "average response time" would understate what a real call actually costs.
    await insertRow({ provider: "openai", operation: "reachability_probe", kind: "probe", totalMs: 5, minutesAgo: 1 });

    const status = await getProviderStatus(
      "openai",
      probeCheck(async () => ({ ok: true }))
    );
    expect(status.avgTotalMs).toBe(2000);
    expect(status.totalSampleCount).toBe(1);
    expect(status.callCountsByOperation).toEqual([{ operation: "extract_contract", count: 1 }]);
  });

  it("averages only samples inside the last 24h and keeps the two latency shapes separate", async () => {
    await insertRow({
      provider: "openai",
      operation: "deliverable_chat",
      firstByteMs: 400,
      totalMs: 900,
      minutesAgo: 5
    });
    await insertRow({
      provider: "openai",
      operation: "deliverable_chat",
      firstByteMs: 600,
      totalMs: 1100,
      minutesAgo: 10
    });
    await insertRow({ provider: "openai", operation: "extract_contract", totalMs: 2000, minutesAgo: 15 });
    // Outside the 24h averaging window but not yet pruned — must not move the averages.
    const outsideHours = AVERAGE_WINDOW_HOURS * 60 + 30;
    await insertRow({ provider: "openai", operation: "extract_contract", totalMs: 99_999, minutesAgo: outsideHours });

    const status = await getProviderStatus(
      "openai",
      probeCheck(async () => ({ ok: true }))
    );
    expect(status.avgFirstByteMs).toBe(500);
    expect(status.firstByteSampleCount).toBe(2);
    expect(status.avgTotalMs).toBe(Math.round((900 + 1100 + 2000) / 3));
    expect(status.totalSampleCount).toBe(3);
  });

  it("breaks real-call volume down by operation over the last 24h", async () => {
    await insertRow({ provider: "google", operation: "geocode", minutesAgo: 2 });
    await insertRow({ provider: "google", operation: "geocode", minutesAgo: 3 });
    await insertRow({ provider: "google", operation: "travel_matrix", minutesAgo: 4 });
    await insertRow({ provider: "google", operation: "geocode", kind: "probe", minutesAgo: 1 }); // probes don't count as call volume

    const status = await getProviderStatus(
      "google",
      probeCheck(async () => ({ ok: true }))
    );
    expect(status.callCountsByOperation).toEqual([
      { operation: "geocode", count: 2 },
      { operation: "travel_matrix", count: 1 }
    ]);
  });

  it("reports the most recent real call regardless of how old it is, and null tokens when none were recorded", async () => {
    await insertRow({ provider: "google", operation: "geocode", ok: false, minutesAgo: 50 });
    await insertRow({ provider: "google", operation: "travel_matrix", ok: true, minutesAgo: 5 });

    const status = await getProviderStatus(
      "google",
      probeCheck(async () => ({ ok: true }))
    );
    expect(status.lastCallOperation).toBe("travel_matrix");
    expect(status.lastCallOk).toBe(true);
    expect(status.inputTokens24h).toBeNull();
    expect(status.outputTokens24h).toBeNull();
  });

  it("sums input and output tokens over the last 24h", async () => {
    await insertRow({
      provider: "openai",
      operation: "extract_contract",
      inputTokens: 500,
      outputTokens: 80,
      minutesAgo: 5
    });
    await insertRow({
      provider: "openai",
      operation: "extract_contract",
      inputTokens: 700,
      outputTokens: 120,
      minutesAgo: 10
    });
    // A streaming call whose usage was unavailable must not turn the total into a false zero-inclusive sum.
    await insertRow({ provider: "openai", operation: "deliverable_chat", minutesAgo: 8 });

    const status = await getProviderStatus(
      "openai",
      probeCheck(async () => ({ ok: true }))
    );
    expect(status.inputTokens24h).toBe(1200);
    expect(status.outputTokens24h).toBe(200);
  });
});

describe("recordProviderProbe and pruning", () => {
  it("records a probe row distinct from a real call", async () => {
    await recordProviderProbe("example_shared", "reachability_probe", async () => ({ ok: true }));
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'example_shared'`;
    expect(rows[0]).toMatchObject({ kind: "probe", operation: "reachability_probe", ok: true });
  });

  it("prunes rows older than the 7-day retention window and leaves recent ones alone", async () => {
    await insertRow({ provider: "openai", minutesAgo: 60 });
    await insertRow({ provider: "openai", minutesAgo: 8 * 24 * 60 });
    await pruneOldProviderTelemetry();
    const rows = await sql`SELECT * FROM provider_call_telemetry WHERE provider = 'openai'`;
    expect(rows).toHaveLength(1);
  });
});
