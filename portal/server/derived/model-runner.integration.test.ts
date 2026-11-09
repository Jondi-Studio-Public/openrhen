import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { promoteExtractorVersion } from "@/server/persistence/postgres/extractor-state-store";
import { saveDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import {
  createPolicyState,
  type HostedEligibilityChecker,
  type ModelOutcome,
  type ModelRequest,
  type ModelTransport,
  type Tier
} from "./call-policy";
import type { ModelExtractor, ModelExtractContext, ModelExtractResult, ModelSourceMessage } from "./model-extractor";
import {
  CIRCUIT_BACKOFF_MS,
  RETRY_COOLDOWN_MS,
  LEASE_MS,
  MODEL_BATCH,
  NO_CONTENT_KEPT,
  trimSkipped,
  MODEL_MESSAGE_BUDGET,
  runModelTick,
  type ModelExtractorResult,
  type ModelTickOptions,
  type ModelTickResult
} from "./model-runner";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_model_runner");

if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}

const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;

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
  sql = postgres(testUrl.toString(), { max: 8, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  await saveDerivedSettings(sql, { ollamaUrl: "http://192.168.1.20:11434", t2Model: "qwen3:8b" });
  await setGate(true);
  counter = 0;
});

afterAll(async () => {
  await sql?.end();
});

const T = new Date("2026-11-08T00:00:00.000Z");
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const NAME = "fact-test";
const DIGEST = "a1b2c3d4e5f6";
const GMAIL = { source: "gmail", kind: "message" };

let counter = 0;
/** A gmail message with text and an exact `ingested_at`. Returns its id and event key. */
async function mail(
  ingested: Date,
  over: { content?: string | null; thread?: string; key?: string; tsStart?: Date } = {}
): Promise<{ id: string; key: string }> {
  counter += 1;
  const key = over.key ?? `g${counter}`;
  const content = over.content === undefined ? `message ${counter}` : over.content;
  const attrs = {
    message_id: `<m${counter}@x>`,
    from: "Sam <sam@example.test>",
    from_self: false,
    thread_id: over.thread ?? `t${counter}`
  };
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, content, ingested_at)
    VALUES (${userId}, 'gmail', 'message', ${key}, ${over.tsStart ?? ingested}, ${sql.json(attrs)}, ${content}, ${ingested})
    RETURNING id`;
  return { id: row!.id, key };
}
async function setGate(enabled: boolean) {
  await sql`
    INSERT INTO activity_source_state (user_id, source, content_enabled) VALUES (${userId}, 'gmail', ${enabled})
    ON CONFLICT (user_id, source) DO UPDATE SET content_enabled = ${enabled}`;
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};

/** A scripted transport: every reply is `ok` unless `behave` answers otherwise. */
function fakeTransport(behave?: (tier: Tier, request: ModelRequest) => ModelOutcome | undefined, digest = DIGEST) {
  const calls: { tier: Tier; request: ModelRequest }[] = [];
  const transport: ModelTransport = {
    async complete(tier, request) {
      calls.push({ tier, request });
      const scripted = behave?.(tier, request);
      if (scripted) return scripted;
      return {
        outcome: "ok",
        text: '{"facts":[]}',
        model: request.model,
        tokensIn: 5,
        tokensOut: 2,
        ...(request.withDigest ? { digest } : {})
      };
    }
  };
  return { transport, calls };
}
const firstUserText = (request: ModelRequest) => request.messages[0]!.content;

const factRow = (message: ModelSourceMessage, suffix = "") => ({
  id: `${NAME}:${message.key}${suffix}`,
  source: "derived",
  kind: "fact",
  start: message.tsStart.toISOString(),
  attrs: {
    source_event_id: message.key,
    fact_id: createHash("sha1").update(`${message.key}${suffix}`).digest("hex"),
    fact_type: "ask",
    extractor: NAME,
    extractor_version: "1",
    tier: "t2",
    span: { start: 0, end: 4, hash: "0123456789ab" }
  }
});

type Handler = (message: ModelSourceMessage, run: ModelExtractContext) => Promise<ModelExtractResult>;
const askModel: Handler = async (message, run) => {
  const reply = await run.call({
    tier: "t2",
    format: "json",
    messages: [{ role: "user", content: message.content }],
    validate: (text) => {
      try {
        JSON.parse(text);
        return null;
      } catch {
        return "it was not JSON";
      }
    }
  });
  if (reply.kind === "failed") return { kind: "failed", outcome: reply.outcome, message: reply.message };
  if (reply.kind === "refused") return { kind: "rows", rows: [] };
  return { kind: "rows", rows: [factRow(message)] };
};

function extractor(handler: Handler = askModel, over: Partial<ModelExtractor> = {}) {
  const seen: string[] = [];
  const made: ModelExtractor = {
    name: NAME,
    version: "1",
    via: `extractor:${NAME}`,
    input: GMAIL,
    notConfigured: (settings) =>
      settings.ollamaUrl && settings.t2Model
        ? null
        : 'Not configured: send PUT /api/derived-settings {"ollamaUrl":"http://<ip>:11434","t2Model":"<model>"}.',
    async extract(message, _context, run) {
      seen.push(message.key);
      return handler(message, run);
    },
    ...over
  };
  return { extractor: made, seen };
}

const run = (
  seconds: number,
  extractors: readonly ModelExtractor[],
  transport: ModelTransport,
  extra: Partial<ModelTickOptions> = {}
) =>
  runModelTick(sql, {
    now: () => at(seconds),
    extractors,
    transport,
    sleep: async () => {},
    policyState: createPolicyState(),
    ...extra
  });

const stateOf = async (version = "1") =>
  (
    await sql<{ cursor: Record<string, any>; active: boolean; last_error: string | null; last_ok_at: Date | null }[]>`
      SELECT cursor, active, last_error, last_ok_at FROM extractor_state WHERE extractor = ${NAME} AND version = ${version}`
  )[0]!;
const rowsOf = (source: string) =>
  sql<{ key: string; attrs: Record<string, any>; via: string }[]>`
    SELECT event_key AS key, attrs, ingested_via AS via FROM activity_events
    WHERE source = ${source} AND kind = 'fact' ORDER BY event_key`;
const lineageCount = async () => (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM derived_lineage`)[0]!.n;
const all = (result: ModelTickResult): ModelExtractorResult[] => {
  if (result.status === "busy") throw new Error("the whole tick answered busy");
  return result.extractors;
};
const only = (result: ModelTickResult): ModelExtractorResult => all(result)[0]!;

describe("the model tick", () => {
  it("is a clean, reported no-op while no extractor is registered", async () => {
    const { transport, calls } = fakeTransport();
    const result = await run(0, [], transport);
    expect(result).toMatchObject({ status: "no_extractors", more: false, extractors: [] });
    expect((result as { summary: string }).summary).toContain("No model extractor is registered");
    expect(calls).toHaveLength(0);
    expect(await sql`SELECT 1 FROM extractor_state`).toHaveLength(0);
  });

  it("creates no version until the extractor is configured, and names the exact call that configures it", async () => {
    await saveDerivedSettings(sql, { ollamaUrl: null });
    const { extractor: ex, seen } = extractor();
    const { transport, calls } = fakeTransport();
    const result = await run(0, [ex], transport);
    expect(only(result)).toMatchObject({ status: "not_configured" });
    expect(only(result).message).toContain('PUT /api/derived-settings {"ollamaUrl"');
    expect(seen).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(await sql`SELECT 1 FROM extractor_state`).toHaveLength(0);
  });

  it("reads batches with content, writes rows in the pinned model's name, pins the digest, and releases the lease", async () => {
    await mail(at(-3600), { content: "old message" });
    const { extractor: ex, seen } = extractor();
    const { transport } = fakeTransport();
    await run(0, [ex], transport); // first run: both watermarks start now; the old message is backfill
    await mail(at(10), { content: "new message" });
    const result = await run(600, [ex], transport);
    expect(only(result)).toMatchObject({ status: "ok", mode: "active", written: expect.any(Number), behind: 0 });
    expect(seen.sort()).toEqual(["g1", "g2"]);
    const rows = await rowsOf("derived");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.via === `extractor:${NAME}`)).toBe(true);
    expect(rows[0]!.attrs.model).toEqual({ id: "qwen3:8b", digest: DIGEST });
    expect(await lineageCount()).toBe(2);
    const state = await stateOf();
    expect(state.active).toBe(true);
    expect(state.cursor.models).toEqual({ t2: { id: "qwen3:8b", digest: DIGEST }, t3: null });
    expect(state.cursor.lease).toBeNull(); // a JSON null, not an absent key
    expect((result as { summary: string }).summary).toContain("behind by 0");
    expect(state.last_error).toBeNull();
  });

  it("uses the model it was pinned to even after the settings change", async () => {
    await mail(at(-100));
    const { extractor: ex } = extractor();
    const { transport, calls } = fakeTransport();
    await run(0, [ex], transport);
    await saveDerivedSettings(sql, { t2Model: "other:14b" });
    await mail(at(10));
    await run(600, [ex], transport);
    expect(new Set(calls.map((c) => c.request.model))).toEqual(new Set(["qwen3:8b"]));
  });

  it("stops with model_changed, consuming nothing, when the model's digest is no longer the pinned one", async () => {
    await mail(at(-100));
    const { extractor: ex, seen } = extractor();
    await run(0, [ex], fakeTransport().transport);
    await mail(at(10));
    const changed = fakeTransport(undefined, "ffffffffffff");
    const result = await run(600, [ex], changed.transport);
    expect(only(result)).toMatchObject({ status: "model_changed" });
    expect(only(result).message).toContain(DIGEST);
    expect(only(result).message).toContain("ffffffffffff");
    expect(seen).toEqual(["g1"]); // g2 was not read
    const state = await stateOf();
    expect(state.cursor.lease).toBeNull();
    expect(state.cursor.retries ?? {}).toEqual({});
  });

  it("reports behind-by-N and asks to be called again while a batch fills", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    for (let i = 0; i < MODEL_BATCH + 5; i++) await mail(at(10 + i));
    const { extractor: ex, seen } = extractor();
    const result = await run(600, [ex], fakeTransport().transport);
    expect(seen).toHaveLength(MODEL_BATCH);
    expect(only(result)).toMatchObject({ behind: 5, more: true });
    expect(result).toMatchObject({ more: true });
    expect((result as { summary: string }).summary).toContain("behind by 5");
    const second = await run(700, [ex], fakeTransport().transport);
    expect(only(second)).toMatchObject({ behind: 0, more: false });
  });

  describe("no content", () => {
    it("says no_content with the exact fix, advances nothing, and leaves no lease, while the gate is off and no text arrived", async () => {
      await setGate(false);
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10), { content: null });
      const { extractor: ex, seen } = extractor();
      const result = await run(600, [ex], fakeTransport().transport);
      expect(only(result)).toMatchObject({ status: "no_content" });
      expect(only(result).message).toContain('PUT /api/activity-sources/gmail {"contentEnabled": true}');
      expect(seen).toHaveLength(0);
      const state = await stateOf();
      expect(state.cursor.lease ?? null).toBeNull();
      expect(state.cursor.skippedIds ?? []).toHaveLength(0);
      // turn the gate on: the same message is still unread, so a mail that arrives with text is read, and this one is skipped by name
      await setGate(true);
      await mail(at(700));
      const next = await run(1200, [ex], fakeTransport().transport);
      expect(only(next)).toMatchObject({ status: "ok", noContent: 1 });
      expect((await stateOf()).cursor.skippedIds).toEqual([expect.objectContaining({ key: "g1", code: "no_content" })]);
      expect(seen).toEqual(["g2"]);
    });

    it("skips a single message with no text by name when the gate is on and its neighbours have text", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10), { content: null });
      await mail(at(11), { content: "text" });
      const { extractor: ex, seen } = extractor();
      const result = await run(600, [ex], fakeTransport().transport);
      expect(only(result)).toMatchObject({ status: "ok", noContent: 1 });
      expect(seen).toEqual(["g2"]);
    });
  });

  describe("leases", () => {
    it("two runs racing one lease read the batch once", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10));
      await mail(at(11));
      const { extractor: ex, seen } = extractor();
      const { transport } = fakeTransport();
      const [a, b] = await Promise.all([run(600, [ex], transport), run(600, [ex], transport)]);
      expect(seen.sort()).toEqual(["g1", "g2"]);
      // The loser is `busy` (the lock), `leased` (the lease) or finds the batch already done: it never reads it again.
      const reads = [a, b].map((r) => (r.status === "busy" ? 0 : only(r).read));
      expect(reads.reduce((sum, n) => sum + n, 0)).toBe(2);
      expect(await rowsOf("derived")).toHaveLength(2);
    });

    it("answers leased, doing nothing, to a run that arrives while another holds the lease", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10));
      const started = deferred();
      const gate = deferred();
      const { extractor: slow } = extractor(async (message, ctx) => {
        started.resolve();
        await gate.promise;
        return askModel(message, ctx);
      });
      const { transport } = fakeTransport();
      const first = run(600, [slow], transport);
      await started.promise;
      const { extractor: other, seen } = extractor();
      const second = await run(601, [other], transport);
      expect(only(second)).toMatchObject({ status: "leased" });
      expect(only(second).message).toContain("lease");
      expect(seen).toHaveLength(0);
      gate.resolve();
      expect(only(await first)).toMatchObject({ status: "ok" });
    });

    it("discards everything a run produced when its lease token is no longer the current one", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10));
      const started = deferred();
      const gate = deferred();
      let first = true;
      const { extractor: ex } = extractor(async (message) => {
        if (first) {
          first = false;
          started.resolve();
          await gate.promise;
          return { kind: "rows", rows: [factRow(message, ":stale-run")] };
        }
        return { kind: "rows", rows: [factRow(message, ":fresh-run")] };
      });
      const { transport } = fakeTransport();
      const slow = run(600, [ex], transport);
      await started.promise;
      // the lease expires; another run takes a new one, finishes, and releases it
      const fresh = await run(600 + LEASE_MS / 1000 + 5, [ex], transport);
      expect(only(fresh)).toMatchObject({ status: "ok" });
      gate.resolve();
      const stale = await slow;
      expect(only(stale)).toMatchObject({ status: "lease_lost" });
      expect(only(stale).message).toContain("discarded");
      const keys = (await rowsOf("derived")).map((r) => r.key);
      expect(keys).toEqual([`${NAME}:g1:fresh-run`]);
    });

    it("tolerates a JSON-null lease key left by the shallow cursor merge, and by a cursor that was never touched", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await sql`UPDATE extractor_state SET cursor = cursor || '{"lease": null}'::jsonb WHERE extractor = ${NAME}`;
      await mail(at(10));
      const { extractor: ex, seen } = extractor();
      const result = await run(600, [ex], fakeTransport().transport);
      expect(only(result)).toMatchObject({ status: "ok" });
      expect(seen).toEqual(["g1"]);
      expect((await stateOf()).cursor.lease).toBeNull();
      // and it takes a lease again afterwards
      await mail(at(700));
      expect(only(await run(1200, [ex], fakeTransport().transport))).toMatchObject({ status: "ok" });
    });

    it("takes over a lease that has expired", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await sql`UPDATE extractor_state SET cursor = cursor || ${sql.json({ lease: { token: "old", startedAt: at(0).toISOString(), expiresAt: at(100).toISOString() } })} WHERE extractor = ${NAME}`;
      await mail(at(10));
      const result = await run(600, [extractor().extractor], fakeTransport().transport);
      expect(only(result)).toMatchObject({ status: "ok" });
    });
  });

  describe("a source that goes away during the calls", () => {
    it("discards the output for a message deleted while the model was working, and the one deleted and re-ingested under a new id", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      const gone = await mail(at(10));
      const replaced = await mail(at(11));
      const kept = await mail(at(12));
      const started = deferred();
      const gate = deferred();
      const { extractor: ex } = extractor(async (message, ctx) => {
        started.resolve();
        await gate.promise;
        return askModel(message, ctx);
      });
      const pending = run(600, [ex], fakeTransport().transport);
      await started.promise;
      await sql`DELETE FROM activity_events WHERE id = ${gone.id}`;
      await sql`DELETE FROM activity_events WHERE id = ${replaced.id}`;
      await mail(at(13), { key: replaced.key, content: "replaced" });
      gate.resolve();
      const result = await pending;
      expect(only(result)).toMatchObject({ status: "ok", discarded: 2 });
      const keys = (await rowsOf("derived")).map((r) => r.attrs.source_event_id);
      expect(keys).toEqual([kept.key]);
      expect(await lineageCount()).toBe(1);
      expect((await stateOf()).cursor.retries ?? {}).toEqual({});
    });
  });

  describe("outages", () => {
    it("consume nothing: no retry, no skip, the cursor stops before the message, and the circuit backs off", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      const first = await mail(at(10));
      const second = await mail(at(11), { content: "outage please" });
      await mail(at(12));
      const { extractor: ex, seen } = extractor();
      const down = fakeTransport((_tier, request) =>
        firstUserText(request).includes("outage please") && !request.withDigest && request.maxTokens !== 8
          ? { outcome: "rate_limited", message: "The model service is busy. Try again later." }
          : undefined
      );
      const result = await run(600, [ex], down.transport);
      expect(only(result)).toMatchObject({ status: "outage", written: 1 });
      expect(only(result).message).toContain("POST /api/derived-settings/test");
      expect(only(result).message).toContain("no message used any of its retry budget");
      expect(seen).toEqual([first.key, second.key]); // stopped at the outage; the third was not tried
      const state = await stateOf();
      expect(state.cursor.retries ?? {}).toEqual({});
      expect(state.cursor.skippedIds ?? []).toEqual([]);
      expect(state.cursor.circuit).toMatchObject({ fails: 1 });
      expect(new Date(state.cursor.circuit.openUntil).getTime()).toBe(at(600).getTime() + CIRCUIT_BACKOFF_MS[0]!);
      expect(state.cursor.lease).toBeNull();
      expect(await rowsOf("derived")).toHaveLength(1);

      // inside the back-off: nothing is called at all
      const before = seen.length;
      const waiting = await run(630, [ex], fakeTransport().transport);
      expect(only(waiting)).toMatchObject({ status: "circuit_open" });
      expect(seen.length).toBe(before);

      // after it: the same message is tried again and everything after it follows
      const healed = fakeTransport();
      const later = await run(600 + CIRCUIT_BACKOFF_MS[0]! / 1000 + 5, [ex], healed.transport);
      expect(only(later)).toMatchObject({ status: "ok" });
      expect(await rowsOf("derived")).toHaveLength(3);
      expect((await stateOf()).cursor.circuit ?? null).toBeNull();
    });

    it("lengthen the back-off on each consecutive failed run, and an unreachable probe is an outage too", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10));
      const { extractor: ex, seen } = extractor();
      const dead = fakeTransport(() => ({ outcome: "unreachable", message: "Could not connect." }));
      let now = 600;
      const waits: number[] = [];
      for (let i = 0; i < 5; i++) {
        const result = await run(now, [ex], dead.transport);
        expect(only(result)).toMatchObject({ status: "outage" });
        const state = await stateOf();
        waits.push(new Date(state.cursor.circuit.openUntil).getTime() - at(now).getTime());
        now += waits[i]! / 1000 + 1;
      }
      expect(waits).toEqual([...CIRCUIT_BACKOFF_MS, CIRCUIT_BACKOFF_MS[CIRCUIT_BACKOFF_MS.length - 1]]);
      expect(seen).toHaveLength(0); // the probe failed every time, so no message was handed to the extractor
    });
  });

  describe("a poison message", () => {
    it("uses one budget unit per timeout, then is skipped by name, kept in skippedIds, while later messages go on", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      const poison = await mail(at(10), { content: "poison" });
      const fine = await mail(at(11));
      const { extractor: ex } = extractor();
      const slow = fakeTransport((_tier, request) =>
        firstUserText(request) === "poison"
          ? { outcome: "timeout", message: "Ollama did not finish within about 3 minutes." }
          : undefined
      );
      let now = 600;
      for (let attempt = 1; attempt < MODEL_MESSAGE_BUDGET; attempt++) {
        const result = await run(now, [ex], slow.transport);
        expect(only(result)).toMatchObject({ status: "ok", failed: 1 });
        const state = await stateOf();
        expect(state.cursor.retries[poison.id]).toMatchObject({ n: attempt });
        now += 3700;
      }
      expect((await rowsOf("derived")).map((r) => r.attrs.source_event_id)).toEqual([fine.key]);
      const last = await run(now, [ex], slow.transport);
      expect(only(last)).toMatchObject({ status: "ok", skipped: 1 });
      const state = await stateOf();
      expect(state.cursor.retries).toEqual({});
      expect(state.cursor.skippedIds).toEqual([
        expect.objectContaining({ id: poison.id, key: poison.key, code: "model_timeout" })
      ]);
      expect(state.cursor.skipped).toBe(1);
      expect(only(last).message).toContain(poison.key);
      // it is never offered again
      const after = await run(now + 3700, [ex], slow.transport);
      expect(only(after)).toMatchObject({ retried: 0, skipped: 0 });
    });

    it("counts bad output the same way, with its own code, and a throwing extractor as extractor_error", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      const bad = await mail(at(10), { content: "bad" });
      const boom = await mail(at(11), { content: "boom" });
      const { extractor: ex } = extractor(async (message, ctx) => {
        if (message.content === "boom") throw new Error("kaput");
        return askModel(message, ctx);
      });
      const transport = fakeTransport((_tier, request) =>
        firstUserText(request) === "bad"
          ? { outcome: "ok", text: "not json", model: request.model, tokensIn: 1, tokensOut: 1 }
          : undefined
      );
      let now = 600;
      for (let i = 0; i < MODEL_MESSAGE_BUDGET; i++) {
        await run(now, [ex], {
          async complete(tier, request) {
            const reply = await transport.transport.complete(tier, request);
            return reply;
          }
        });
        now += 3700;
      }
      const skipped = (await stateOf()).cursor.skippedIds as { key: string; code: string }[];
      expect(skipped.map((s) => [s.key, s.code]).sort()).toEqual([
        [bad.key, "bad_output"],
        [boom.key, "extractor_error"]
      ]);
    });

    it("forgets a budget older than 24 hours: six failures spread over days never skip a message", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      const poison = await mail(at(10), { content: "poison" });
      const { extractor: ex } = extractor();
      const slow = fakeTransport((_tier, request) =>
        firstUserText(request) === "poison" ? { outcome: "timeout", message: "slow" } : undefined
      );
      let now = 600;
      for (let i = 0; i < MODEL_MESSAGE_BUDGET + 2; i++) {
        await run(now, [ex], slow.transport);
        now += 25 * 3600;
      }
      const state = await stateOf();
      expect(state.cursor.skippedIds ?? []).toEqual([]);
      expect(state.cursor.retries[poison.id].n).toBe(1);
    });
  });

  describe("the wall-clock budget", () => {
    it("stops starting messages when the budget is spent, advances only past what was done, and asks to be called again", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      for (let i = 0; i < 4; i++) await mail(at(10 + i));
      let clock = 0;
      const { extractor: ex, seen } = extractor(async (message, ctx) => {
        clock += 100_000; // each message takes 100 s
        return askModel(message, ctx);
      });
      const result = await run(600, [ex], fakeTransport().transport, { clock: () => clock, budgetMs: 250_000 });
      expect(seen).toEqual(["g1", "g2", "g3"]);
      expect(only(result)).toMatchObject({ status: "ok", more: true, behind: 1 });
      expect(await rowsOf("derived")).toHaveLength(3);
      const rest = await run(700, [ex], fakeTransport().transport, { clock: () => 0 });
      expect(only(rest)).toMatchObject({ more: false, behind: 0 });
      expect(seen).toEqual(["g1", "g2", "g3", "g4"]);
    });
  });

  describe("rows the store refuses", () => {
    it("write the good rows, count the message as failed once, and retry it", async () => {
      await run(0, [extractor().extractor], fakeTransport().transport);
      await mail(at(10));
      const { extractor: ex } = extractor(async (message) => ({
        kind: "rows",
        rows: [factRow(message), { id: "bad", source: "derived", kind: "fact", start: "not a time", attrs: {} }]
      }));
      const result = await run(600, [ex], fakeTransport().transport);
      expect(only(result)).toMatchObject({ failed: 1, written: 1 });
      expect(await rowsOf("derived")).toHaveLength(1);
      expect(Object.keys((await stateOf()).cursor.retries)).toHaveLength(1);
    });
  });

  describe("shadow runs", () => {
    it("run a version that is not active over the labelled messages and live mail, into derived-shadow, and record cursor.shadow.done", async () => {
      // version 1 is active (created first); version 2 is a candidate
      const v1 = extractor();
      await mail(at(-3600), { content: "labelled and old" });
      await mail(at(-3500), { content: "old and unlabelled" });
      const v2 = extractor(
        async (message, ctx) => {
          const rows = (await askModel(message, ctx)) as { kind: "rows"; rows: any[] };
          return {
            kind: "rows",
            rows: rows.rows.map((r) => ({ ...r, attrs: { ...r.attrs, extractor_version: "2" } }))
          };
        },
        { version: "2" }
      );
      await run(0, [v1.extractor, v2.extractor], fakeTransport().transport); // both versions exist from here
      await sql`
        INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
        VALUES (${userId}, 'derived', 'label', 'label-1', ${at(5)}, ${sql.json({ source_event_id: "g1", field: "fact_types", answer: ["ask"] })})`;
      await mail(at(10), { content: "live mail" });
      const { transport } = fakeTransport();
      const result = await run(600, [v1.extractor, v2.extractor], transport);
      expect(result).toMatchObject({ status: "ok" });
      const shadow = all(result).find((e) => e.version === "2")!;
      expect(shadow).toMatchObject({ mode: "shadow", status: "ok" });
      expect(v2.seen.sort()).toEqual(["g1", "g3"]); // the labelled message and the live one; the unlabelled old one is not backfilled
      expect((await rowsOf("derived-shadow")).map((r) => r.attrs.source_event_id).sort()).toEqual(["g1", "g3"]);
      expect((await rowsOf("derived-shadow")).every((r) => r.attrs.extractor_version === "2")).toBe(true);
      const state = await stateOf("2");
      expect(state.active).toBe(false);
      expect(state.cursor.shadow.done).toEqual(["g1", "g3"]);
      expect(state.cursor.backfill).toBeUndefined();

      // The shape the eval report's reader takes (a verbatim mirror of `reachedMessages` in eval-report-store.ts, 2b-1b)
      const held = new Map(
        (
          await sql<
            { id: string; event_key: string }[]
          >`SELECT id, event_key FROM activity_events WHERE source = 'gmail'`
        ).map((row) => [row.event_key, { id: row.id, mark: { at: "", id: row.id } }])
      );
      expect([...mirrorReachedMessages(false, state.cursor, held)].sort()).toEqual(["g1", "g3"]);
    });

    it("does not run a message twice, keeps done bounded, and never counts a skipped or retrying message as reached", async () => {
      const v1 = extractor();
      await run(0, [v1.extractor], fakeTransport().transport);
      const poison = await mail(at(10), { content: "poison" });
      await mail(at(11));
      const v2 = extractor(askModel, { version: "2" });
      const { transport } = fakeTransport((_tier, request) =>
        firstUserText(request) === "poison" ? { outcome: "timeout", message: "slow" } : undefined
      );
      await run(100, [v1.extractor, v2.extractor], transport); // v2's first run: forward starts here, so it sees nothing
      await mail(at(200), { content: "poison" });
      await mail(at(201));
      const result = await run(900, [v1.extractor, v2.extractor], transport);
      expect(all(result).find((e) => e.version === "2")).toMatchObject({ mode: "shadow", failed: 1 });
      const state = await stateOf("2");
      expect(state.cursor.shadow.done).toEqual(["g4"]);
      const held = new Map([
        ["g3", { id: "p", mark: { at: "", id: "p" } }],
        ["g4", { id: "q", mark: { at: "", id: "q" } }]
      ]);
      state.cursor.retries = { p: { n: 1 } };
      state.cursor.shadow.done.push("g3");
      expect([...mirrorReachedMessages(false, state.cursor, held)]).toEqual(["g4"]);
      expect(poison.key).toBeDefined();
    });
  });

  describe("hosted models", () => {
    it("never sends to the hosted tier by default: with no hosted key saved the real rule refuses, and says why", async () => {
      await saveDerivedSettings(sql, { t3Model: "meta-llama/Llama-3.3-70B-Instruct" });
      const replies: string[] = [];
      const { extractor: ex } = extractor(async (message, ctx) => {
        const reply = await ctx.call({ tier: "t3", messages: [{ role: "user", content: message.content }] });
        replies.push(reply.kind === "refused" ? `${reply.reason}: ${reply.message}` : reply.kind);
        return { kind: "rows", rows: [] };
      });
      await run(0, [ex], fakeTransport().transport);
      await mail(at(10));
      const { transport, calls } = fakeTransport();
      await run(600, [ex], transport);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("not_eligible");
      expect(replies[0]).toContain("no hosted API key is saved");
      expect(calls.filter((c) => c.tier === "t3")).toHaveLength(0);
      expect(await sql`SELECT 1 FROM derived_model_calls`).toHaveLength(0);
    });

    it("a shadow version sends to the hosted tier only up to SHADOW_HOSTED_SHARE of the daily cap, and the active version keeps the rest", async () => {
      await saveDerivedSettings(sql, { t3Model: "meta-llama/Llama-3.3-70B-Instruct", t3DailyMessageCap: 20 });
      const yes: HostedEligibilityChecker = async () => ({ eligible: true });
      const outcomes = { shadow: [] as string[], active: [] as string[] };
      const hostedCaller = (into: string[]) => async (message: ModelSourceMessage, ctx: ModelExtractContext) => {
        const reply = await ctx.call({ tier: "t3", messages: [{ role: "user", content: message.content }] });
        into.push(reply.kind === "refused" ? reply.reason : reply.kind);
        return { kind: "rows" as const, rows: [] };
      };
      const v1 = extractor(hostedCaller(outcomes.active));
      const v2 = extractor(hostedCaller(outcomes.shadow), { version: "2" });
      await run(0, [v1.extractor, v2.extractor], fakeTransport().transport, { isHostedEligible: yes });
      for (let i = 0; i < 8; i += 1) await mail(at(10 + i));
      const { transport } = fakeTransport();
      await run(600, [v1.extractor, v2.extractor], transport, { isHostedEligible: yes });
      // The active version is read first and has the whole cap of 20, so all 8 sends go.
      expect(outcomes.active.filter((o) => o === "ok")).toHaveLength(8);
      // The shadow version sees 8 sends already used in the last 24 hours, which is over its share of 4: every send is refused.
      expect(outcomes.shadow).toHaveLength(8);
      expect(new Set(outcomes.shadow)).toEqual(new Set(["message_cap"]));
    });

    it("a shadow version sends while the last 24 hours' sends are under its share", async () => {
      await saveDerivedSettings(sql, { t3Model: "meta-llama/Llama-3.3-70B-Instruct", t3DailyMessageCap: 20 });
      const yes: HostedEligibilityChecker = async () => ({ eligible: true });
      const shadow: string[] = [];
      const v1 = extractor();
      const v2 = extractor(
        async (message, ctx) => {
          const reply = await ctx.call({ tier: "t3", messages: [{ role: "user", content: message.content }] });
          shadow.push(reply.kind === "refused" ? reply.reason : reply.kind);
          return { kind: "rows", rows: [] };
        },
        { version: "2" }
      );
      await run(0, [v1.extractor, v2.extractor], fakeTransport().transport, { isHostedEligible: yes });
      for (let i = 0; i < 7; i += 1) await mail(at(10 + i));
      await run(600, [v1.extractor, v2.extractor], fakeTransport().transport, { isHostedEligible: yes });
      // Cap 20 gives a share of 4: the first four sends go, the rest are refused at the share.
      expect(shadow.filter((o) => o === "ok")).toHaveLength(4);
      expect(shadow.filter((o) => o === "message_cap")).toHaveLength(3);
    });

    it("sends once an eligibility checker says yes, and passes it the event key", async () => {
      await saveDerivedSettings(sql, { t3Model: "meta-llama/Llama-3.3-70B-Instruct" });
      const asked: string[] = [];
      const yes: HostedEligibilityChecker = async (subject) => {
        asked.push(subject.sourceEventKey);
        return { eligible: true };
      };
      const { extractor: ex } = extractor(async (message, ctx) => {
        await ctx.call({ tier: "t3", messages: [{ role: "user", content: message.content }] });
        return { kind: "rows", rows: [] };
      });
      await run(0, [ex], fakeTransport().transport);
      await mail(at(10));
      const { transport, calls } = fakeTransport();
      await run(600, [ex], transport, { isHostedEligible: yes });
      expect(calls.filter((c) => c.tier === "t3")).toHaveLength(1);
      expect(asked).toEqual(["g1"]);
    });
  });
});

describe("review findings", () => {
  const live = async (v: string[]) => v;

  it("F1: hosted-capable versions get only the context messages the eligibility rule accepts", async () => {
    await saveDerivedSettings(sql, { t3Model: "meta-llama/Llama-3.3-70B-Instruct" });
    const contexts = new Map<string, string[]>();
    const { extractor: ex } = extractor(askModel, {
      async extract(message, context) {
        contexts.set(
          message.key,
          context.map((c) => c.key)
        );
        return { kind: "rows", rows: [] };
      }
    });
    await run(0, [ex], fakeTransport().transport);
    await mail(at(10), { thread: "T", key: "ctx-bad" });
    await mail(at(11), { thread: "T", key: "ctx-good" });
    await mail(at(12), { thread: "T", key: "target" });
    const asked: string[] = [];
    await run(600, [ex], fakeTransport().transport, {
      isHostedEligible: async ({ sourceEventKey }) => {
        asked.push(sourceEventKey);
        return sourceEventKey === "ctx-bad" ? { eligible: false, reason: "banking" } : { eligible: true };
      }
    });
    expect(contexts.get("target")).toEqual(["ctx-good"]);
    expect(asked).toContain("ctx-bad");
    // without a test checker the real rule runs on the database: plain mail from a person passes it
    contexts.clear();
    await mail(at(700), { thread: "T", key: "later" });
    await run(1200, [ex], fakeTransport().transport);
    expect(contexts.get("later")).toEqual(["ctx-bad", "ctx-good", "target"]);
  });

  it("F2: a version promoted while its run was calling the model writes nothing, and releases its lease", async () => {
    const v1 = extractor();
    const v2 = extractor(askModel, { version: "2" });
    await run(0, [v1.extractor, v2.extractor], fakeTransport().transport);
    await mail(at(10));
    const started = deferred();
    const gate = deferred();
    const slow = extractor(async (m, c) => {
      started.resolve();
      await gate.promise;
      return askModel(m, c);
    });
    const pending = run(600, [slow.extractor], fakeTransport().transport);
    await started.promise;
    await promoteExtractorVersion(sql, userId, NAME, "2", at(601));
    gate.resolve();
    const result = await pending;
    expect(only(result)).toMatchObject({ status: "lease_lost" });
    expect(only(result).message).toContain("promot");
    expect(await rowsOf("derived")).toHaveLength(0);
    expect((await stateOf("1")).cursor.lease).toBeNull();
  });

  it("F2: and a shadow version promoted mid-run does not write shadow rows", async () => {
    const v1 = extractor();
    const v2 = extractor(askModel, { version: "2" });
    await run(0, [v1.extractor, v2.extractor], fakeTransport().transport);
    await mail(at(10));
    const started = deferred();
    const gate = deferred();
    const slow = extractor(
      async (m, c) => {
        started.resolve();
        await gate.promise;
        return askModel(m, c);
      },
      { version: "2" }
    );
    const pending = run(600, [slow.extractor], fakeTransport().transport);
    await started.promise;
    await promoteExtractorVersion(sql, userId, NAME, "2", at(601));
    gate.resolve();
    expect(only(await pending)).toMatchObject({ status: "lease_lost" });
    expect(await rowsOf("derived-shadow")).toHaveLength(0);
  });

  it("F3: a pinned digest the probe cannot confirm is never stamped, and the run reads nothing", async () => {
    await mail(at(-100));
    const { extractor: ex, seen } = extractor();
    await run(0, [ex], fakeTransport().transport);
    expect((await stateOf()).cursor.models.t2.digest).toBe(DIGEST);
    await mail(at(10));
    const blind = fakeTransport((_t, request) =>
      request.withDigest ? { outcome: "ok", text: "OK", model: request.model, tokensIn: 1, tokensOut: 1 } : undefined
    );
    const before = seen.length;
    const result = await run(600, [ex], blind.transport);
    expect(only(result)).toMatchObject({ status: "model_changed" });
    expect(only(result).message).toContain("could not confirm");
    expect(seen.length).toBe(before);
    expect((await rowsOf("derived")).every((r) => r.attrs.model.digest === DIGEST)).toBe(true);
  });

  it("F3: with no digest ever known, rows name the model without a digest", async () => {
    await mail(at(-100));
    const { extractor: ex } = extractor();
    const blind = fakeTransport((_t, request) =>
      request.withDigest ? { outcome: "ok", text: "OK", model: request.model, tokensIn: 1, tokensOut: 1 } : undefined
    );
    await run(0, [ex], blind.transport);
    const rows = await rowsOf("derived");
    expect(rows[0]!.attrs.model).toEqual({ id: "qwen3:8b" });
  });

  it("F4: renews the lease after each message so a long run never outlives it", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    for (let i = 0; i < 3; i++) await mail(at(10 + i));
    const expiries: string[] = [];
    const { extractor: ex } = extractor(async (m, c) => {
      expiries.push((await stateOf()).cursor.lease.expiresAt);
      return askModel(m, c);
    });
    let t = 600;
    await run(0, [ex], fakeTransport().transport, { now: () => at((t += 120)) });
    expect(expiries).toHaveLength(3);
    expect(new Set(expiries).size).toBe(3);
    expect(expiries).toEqual([...expiries].sort());
    expect(LEASE_MS).toBeGreaterThanOrEqual(15 * 60_000);
  });

  it("F5: keeps more than 50 no-text skips, so the eval report never counts them reached", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    for (let i = 0; i < 60; i++) await mail(at(10 + i), { content: null });
    await mail(at(100), { content: "has text" });
    const { extractor: ex } = extractor();
    await run(600, [ex], fakeTransport().transport, { batch: 70 });
    const ids = (await stateOf()).cursor.skippedIds as { code: string }[];
    expect(ids.filter((s) => s.code === "no_content")).toHaveLength(60);
    expect(NO_CONTENT_KEPT).toBeGreaterThanOrEqual(60);
  });

  it("F6: a shadow run never loops on a labelled message with no text, and does not read a labelled message twice", async () => {
    const v1 = extractor();
    const v2 = extractor(askModel, { version: "2" });
    await run(0, [v1.extractor, v2.extractor], fakeTransport().transport);
    await mail(at(-3600), { content: null, key: "textless" });
    await mail(at(590), { key: "fresh" });
    for (const key of ["textless", "fresh"])
      await sql`
        INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
        VALUES (${userId}, 'derived', 'label', ${`label-${key}`}, ${at(5)}, ${sql.json({ source_event_id: key, field: "fact_types", answer: [] })})`;
    const first = await run(600, [v2.extractor], fakeTransport().transport);
    expect(only(first)).toMatchObject({ behind: expect.any(Number) });
    await run(700, [v2.extractor], fakeTransport().transport);
    const again = await run(800, [v2.extractor], fakeTransport().transport);
    expect(v2.seen.filter((k) => k === "fresh")).toHaveLength(1);
    expect(v2.seen).not.toContain("textless");
    expect(only(again).behind).toBe(0);
  });

  it("F7: a call to a tier with no pinned model is refused with the settings fix, and opens no circuit", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    await mail(at(10));
    const replies: string[] = [];
    const { extractor: ex } = extractor(async (m, ctx) => {
      const r = await ctx.call({ tier: "t3", messages: [{ role: "user", content: m.content }] });
      replies.push(r.kind === "refused" ? `${r.reason}|${r.message}` : r.kind);
      return { kind: "rows", rows: [] };
    });
    await run(600, [ex], fakeTransport().transport);
    expect(replies[0]).toContain("not_eligible");
    expect(replies[0]).toContain("PUT /api/derived-settings");
    expect((await stateOf()).cursor.circuit ?? null).toBeNull();
  });

  it("F8: once the opening call worked, an unreachable answer on a message is charged to that message", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    const down = await mail(at(10), { content: "down" });
    await mail(at(11));
    const { extractor: ex } = extractor();
    const t = fakeTransport((_t, r) =>
      firstUserText(r) === "down" ? { outcome: "unreachable", message: "Could not connect." } : undefined
    );
    const result = await run(600, [ex], t.transport);
    expect(only(result)).toMatchObject({ status: "ok", failed: 1, written: 1 });
    const state = await stateOf();
    expect(state.cursor.retries[down.id]).toMatchObject({ n: 1 });
    expect(state.cursor.circuit ?? null).toBeNull();
  });

  it("F9: a failed message waits out a cool-down before it is tried again", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    const poison = await mail(at(10), { content: "poison" });
    const { extractor: ex, seen } = extractor();
    const slow = fakeTransport((_t, r) =>
      firstUserText(r) === "poison" ? { outcome: "timeout", message: "slow" } : undefined
    );
    await run(600, [ex], slow.transport);
    expect(seen.filter((k) => k === poison.key)).toHaveLength(1);
    await run(620, [ex], slow.transport);
    expect(seen.filter((k) => k === poison.key)).toHaveLength(1); // still cooling down
    await run(600 + RETRY_COOLDOWN_MS[0]! / 1000 + 5, [ex], slow.transport);
    expect(seen.filter((k) => k === poison.key)).toHaveLength(2);
  });

  it("F9: several timeouts in a row are an outage, not a batch of skipped messages", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    for (let i = 0; i < 4; i++) await mail(at(10 + i), { content: "slow" });
    const { extractor: ex } = extractor();
    const slow = fakeTransport((_t, r) =>
      firstUserText(r) === "slow" ? { outcome: "timeout", message: "slow" } : undefined
    );
    const result = await run(600, [ex], slow.transport);
    expect(only(result)).toMatchObject({ status: "outage", failed: 0 });
    const state = await stateOf();
    expect(state.cursor.retries ?? {}).toEqual({});
    expect(state.cursor.circuit).toMatchObject({ fails: 1 });
  });

  it("F10: a circuit that expired with nothing to read is cleared, so the next outage starts at one minute", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    const m = await mail(at(10));
    const { extractor: ex } = extractor();
    const dead = fakeTransport(() => ({ outcome: "unreachable", message: "no" }));
    await run(600, [ex], dead.transport);
    expect((await stateOf()).cursor.circuit.fails).toBe(1);
    await sql`DELETE FROM activity_events WHERE id = ${m.id}`;
    await run(600 + 70, [ex], fakeTransport().transport);
    expect((await stateOf()).cursor.circuit ?? null).toBeNull();
  });

  it("F12: no mail text reaches lastError, the result or the cursor, even when a validator quotes it", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    const secret = "meet me at the old cafe on friday";
    await mail(at(10), { content: secret });
    const { extractor: ex } = extractor(async (m, ctx) => {
      const r = await ctx.call({
        tier: "t2",
        format: "json",
        messages: [{ role: "user", content: m.content }],
        validate: (text) => `the reply "${text}" ignored: ${m.content}`
      });
      if (r.kind === "failed") return { kind: "failed", outcome: r.outcome, message: r.message };
      return { kind: "rows", rows: [] };
    });
    const result = await run(600, [ex], fakeTransport().transport);
    const state = await stateOf();
    const everything = JSON.stringify([result, state.cursor, state.last_error]);
    expect(everything).not.toContain("old cafe");
    expect(state.last_error).toContain("failed this run");
    void live;
  });
});

describe("review round 2", () => {
  it("shadow runs honour the retry cool-down for a labelled message too", async () => {
    const v1 = extractor(async () => ({ kind: "rows", rows: [] }));
    await mail(at(-3600), { content: "poison" });
    const v2 = extractor(askModel, { version: "2" });
    await run(0, [v1.extractor, v2.extractor], fakeTransport().transport);
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs)
      VALUES (${userId}, 'derived', 'label', 'label-1', ${at(5)}, ${sql.json({ source_event_id: "g1", field: "fact_types", answer: ["ask"] })})`;
    const slow = fakeTransport((_t, r) =>
      firstUserText(r) === "poison" ? { outcome: "timeout", message: "slow" } : undefined
    );
    await run(600, [v1.extractor, v2.extractor], slow.transport);
    expect(v2.seen).toEqual(["g1"]);
    await run(620, [v1.extractor, v2.extractor], slow.transport);
    expect(v2.seen).toEqual(["g1"]); // still cooling down
    await run(600 + RETRY_COOLDOWN_MS[0]! / 1000 + 5, [v1.extractor, v2.extractor], slow.transport);
    expect(v2.seen).toEqual(["g1", "g1"]);
  });

  it("model_changed opens a circuit that grows, so the digest is not probed every tick", async () => {
    await mail(at(-100));
    const { extractor: ex } = extractor();
    await run(0, [ex], fakeTransport().transport);
    await mail(at(10));
    const changed = fakeTransport(undefined, "ffffffffffff");
    expect(only(await run(600, [ex], changed.transport))).toMatchObject({ status: "model_changed" });
    const probes = changed.calls.length;
    expect((await stateOf()).cursor.circuit).toMatchObject({ fails: 1 });
    const paused = only(await run(610, [ex], changed.transport));
    expect(paused).toMatchObject({ status: "circuit_open" });
    expect(paused.message).toContain("digest");
    expect(paused.message).toContain("GET /api/activity-events/summary?report=eval");
    expect(changed.calls.length).toBe(probes); // no call while paused
    expect(only(await run(600 + CIRCUIT_BACKOFF_MS[0]! / 1000 + 1, [ex], changed.transport))).toMatchObject({
      status: "model_changed"
    });
    expect((await stateOf()).cursor.circuit).toMatchObject({ fails: 2 });
    // The pinned model coming back clears it.
    await run(600 + 3600, [ex], fakeTransport().transport);
    expect((await stateOf()).cursor.circuit ?? null).toBeNull();
  });

  it("saves the digest it learned even when the first run ends in an outage", async () => {
    const { extractor: ex } = extractor();
    await run(0, [ex], fakeTransport().transport);
    for (let i = 0; i < 4; i++) await mail(at(10 + i), { content: "slow" });
    const slow = fakeTransport((_t, r) =>
      firstUserText(r) === "slow" ? { outcome: "timeout", message: "slow" } : undefined
    );
    const result = await run(600, [ex], slow.transport);
    expect(only(result)).toMatchObject({ status: "outage" });
    expect((await stateOf()).cursor.models.t2.digest).toBe(DIGEST);
  });

  it("agent-facing messages name the exact next call", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    await mail(at(-30));
    const idle = only(await run(10, [extractor().extractor], fakeTransport().transport));
    expect(idle.message).toContain("POST /api/integrations/derived/model-tick");
    expect(idle.message).toContain("GET /api/activity-events/summary?report=eval");

    await mail(at(20));
    const dead = fakeTransport(() => ({ outcome: "unreachable", message: "Could not connect." }));
    const down = only(await run(600, [extractor().extractor], dead.transport));
    expect(down.message).toContain("No message was read");
    expect(down.message).toContain('POST /api/derived-settings/test {"tier":"t2"}');
    expect(down.message).toContain('{"tier":"t3"}');
  });

  it("a failed message's note names when and what to call", async () => {
    await run(0, [extractor().extractor], fakeTransport().transport);
    await mail(at(10), { content: "poison" });
    const slow = fakeTransport((_t, r) =>
      firstUserText(r) === "poison" ? { outcome: "timeout", message: "slow" } : undefined
    );
    const result = only(await run(600, [extractor().extractor], slow.transport));
    expect(result.message).toContain("POST /api/integrations/derived/model-tick");
    expect(result.message).toContain(at(600 + RETRY_COOLDOWN_MS[0]! / 1000).toISOString());
  });
});

describe("trimSkipped", () => {
  const entry = (i: number, code: string) => ({ id: `i${i}`, key: `k${i}`, code, at: "t" });
  it("keeps the newest 50 ordinary skips and the no-text ones separately", () => {
    const list = [
      ...Array.from({ length: 70 }, (_, i) => entry(i, "model_timeout")),
      ...Array.from({ length: 300 }, (_, i) => entry(1000 + i, "no_content"))
    ];
    const kept = trimSkipped(list);
    expect(kept.filter((e) => e.code === "model_timeout")).toHaveLength(50);
    expect(kept.filter((e) => e.code === "no_content")).toHaveLength(300);
    expect(kept.filter((e) => e.code === "model_timeout")[0]!.id).toBe("i20");
  });
  it("never drops a labelled message's skip, so a shadow run cannot read a poison message again", () => {
    const list = Array.from({ length: 70 }, (_, i) => entry(i, "model_timeout"));
    const kept = trimSkipped(list, new Set(["k0", "k1"]));
    expect(kept.map((e) => e.id)).toEqual(expect.arrayContaining(["i0", "i1"]));
    expect(kept.filter((e) => e.code === "model_timeout")).toHaveLength(52);
  });
  it("bounds the no-text ones too", () => {
    const kept = trimSkipped(Array.from({ length: NO_CONTENT_KEPT + 5 }, (_, i) => entry(i, "no_content")));
    expect(kept).toHaveLength(NO_CONTENT_KEPT);
  });
});

/** Verbatim mirror of `reachedMessages` (portal/server/persistence/postgres/eval-report-store.ts on 2b-1b), the reader of `cursor.shadow.done`. */
function mirrorReachedMessages(
  active: boolean,
  cursor: Record<string, unknown>,
  held: Map<string, { id: string; mark: { at: string; id: string } }>
) {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const reached = new Set<string>();
  if (active) return reached;
  const done = record(cursor.shadow).done;
  if (!Array.isArray(done)) return reached;
  const listed = new Set(done.slice(-200_000).filter((item): item is string => typeof item === "string"));
  for (const [key, message] of held) if (listed.has(key) || listed.has(message.id)) reached.add(key);
  const unread = new Set<string>(Object.keys(record(cursor.retries)));
  if (Array.isArray(cursor.skippedIds))
    for (const item of cursor.skippedIds) {
      const entry = record(item);
      if (typeof entry.id === "string") unread.add(entry.id);
      if (typeof entry.key === "string") unread.add(entry.key);
    }
  for (const [key, message] of held) if (unread.has(key) || unread.has(message.id)) reached.delete(key);
  return reached;
}
