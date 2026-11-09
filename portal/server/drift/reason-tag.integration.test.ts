import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { withheldActivitySources } from "@openrhen/contracts";
import { createPolicyState, type ModelOutcome, type ModelTransport } from "@/server/derived/call-policy";
import { readActivityEvents } from "@/server/persistence/postgres/activity-store";
import { saveDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { deleteReason, saveReason } from "./drift-reasons";
import {
  ATTEMPT_CAP,
  SCAN_LIMIT,
  TICK_BATCH,
  backoffMs,
  createReasonTagAttempts,
  runReasonTagTick,
  type ReasonTagAttempts
} from "./reason-tag-runner";
import { readReasonTags, setReasonTags } from "./reason-tags";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_reason_tag");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let attempts: ReasonTagAttempts;
let sequence = 0;

/** Synthetic phrases that are easy to spot if they leak. */
const WORDS = (n: number) => `zebra-${n} kettle noise outside`;

async function checkIn() {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO check_in (user_id, slot_at, answered_at, directive_kind, directive_title, status, answered_by, answer_source)
    VALUES (${userId}, '2026-11-09T01:00:00Z', '2026-11-09T01:05:00Z', 'none', 'Synthetic task', 'deviated', NULL, 'sheet')
    RETURNING id`;
  return row!.id;
}
/** A reason with its own check-in; returns the check-in id. */
async function reason(text: string, checkInId?: string, daysAgo?: number) {
  const id = checkInId ?? (await checkIn());
  sequence += 1;
  if (daysAgo !== undefined) {
    // The store is append-only, so an old reason is written old rather than aged afterwards.
    const requestId = `req-${String(sequence).padStart(8, "0")}`;
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at)
      VALUES (${userId}, 'drift-reason', 'reason', ${`reason|${id}|${requestId}`}, '2026-11-09T01:05:00Z',
        ${sql.json({ check_in_id: id, text, request_id: requestId })}, now() - make_interval(days => ${daysAgo}))`;
    return id;
  }
  const saved = await saveReason(sql, { checkInId: id, text, requestId: `req-${String(sequence).padStart(8, "0")}` });
  expect(saved).toMatchObject({ ok: true });
  return id;
}
const tagRows = () =>
  sql<{ event_key: string; attrs: Record<string, unknown>; ingested_via: string | null }[]>`
    SELECT event_key, attrs, ingested_via FROM activity_events WHERE source = 'drift-reason' AND kind = 'reason_tag'
    ORDER BY ingested_at, event_key`;

/** A transport that answers by the words in the prompt, and records the prompts it was shown, in order. */
function transport(answer: (prompt: string) => string | ModelOutcome) {
  const prompts: string[] = [];
  const complete = vi.fn(async (_tier: string, request: { messages: { content: string }[] }): Promise<ModelOutcome> => {
    const prompt = request.messages.map((message) => message.content).join("\n");
    // The policy warms the model up with a fixed question before its first real call in a process; that is not a reason.
    if (!prompt.includes("single word OK")) prompts.push(prompt);
    const reply = answer(prompt);
    return typeof reply === "string"
      ? { outcome: "ok", text: reply, model: "model:8b", tokensIn: 1, tokensOut: 1 }
      : reply;
  });
  return { transport: { complete } as unknown as ModelTransport, prompts, complete };
}
const TAGS = '{"tags":["kettle noise","outside"]}';
let clock = Date.now();
const run = (t: ModelTransport, offsetMs = 0) =>
  runReasonTagTick(sql, {
    now: () => new Date(clock + offsetMs),
    transport: t,
    sleep: async () => {},
    policyState: createPolicyState(),
    attempts,
    newBoundary: () => "b".repeat(24)
  });

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
  await saveDerivedSettings(sql, { t2Model: "model:8b" });
  attempts = createReasonTagAttempts();
  clock = Date.now();
});

afterAll(async () => {
  await sql.end();
});

describe("runReasonTagTick", () => {
  it("says it is not configured, and does nothing, with no local model", async () => {
    await saveDerivedSettings(sql, { t2Model: null });
    await reason(WORDS(1));
    const t = transport(() => TAGS);
    expect(await run(t.transport)).toMatchObject({ status: "not_configured", more: false, tagged: 0 });
    expect(t.prompts).toHaveLength(0);
  });

  it("tags oldest first, stores the model's rows with its stamp, and goes idle", async () => {
    const first = await reason(WORDS(1));
    const second = await reason(WORDS(2));
    const t = transport(() => TAGS);
    const result = await run(t.transport);
    expect(result).toMatchObject({ status: "ok", tagged: 2, more: false });
    expect(t.prompts[0]).toContain(WORDS(1));
    expect(t.prompts[1]).toContain(WORDS(2));
    const stored = await tagRows();
    expect(stored.map((row) => row.attrs.check_in_id)).toEqual([first, second]);
    expect(stored[0]).toMatchObject({
      ingested_via: "drift:reason-tag",
      attrs: { origin: "inferred", tags: ["kettle noise", "outside"], model: { id: "model:8b" }, prompt_version: 1 }
    });
    expect(stored[0]!.event_key).toBe(`reason_tag|${first}|inferred|v1|model:8b`);
    expect(await run(t.transport)).toMatchObject({ status: "idle", tagged: 0 });
    expect(t.prompts).toHaveLength(2);
  });

  it("sends only the owner's words: no plan text, no earlier tag, no tag list", async () => {
    await sql`INSERT INTO areas (user_id, name, private, status, sort_order) VALUES (${userId}, 'Synthetic Study', false, 'active', 1)`;
    const id = await reason(WORDS(1));
    await setReasonTags(sql, { checkInId: id, tags: ["my own phrase"], reset: undefined, requestId: "req-aaaaaaaa" });
    await setReasonTags(sql, { checkInId: id, tags: undefined, reset: true, requestId: "req-bbbbbbbb" });
    const other = await reason(WORDS(2));
    await setReasonTags(sql, {
      checkInId: other,
      tags: ["different phrase"],
      reset: undefined,
      requestId: "req-cccccccc"
    });
    const t = transport(() => TAGS);
    await run(t.transport);
    const shown = t.prompts.join("\n");
    expect(shown).toContain(WORDS(1));
    expect(shown).not.toMatch(/Synthetic|my own phrase|different phrase|Synthetic task|deviated/);
    // The owner's answered reason is never sent at all.
    expect(shown).not.toContain(WORDS(2));
  });

  it("tags at most TICK_BATCH reasons a tick, oldest first, and says more are waiting", async () => {
    for (let n = 1; n <= TICK_BATCH + 2; n += 1) await reason(WORDS(n));
    const t = transport(() => TAGS);
    expect(await run(t.transport)).toMatchObject({ status: "ok", tagged: TICK_BATCH, more: true });
    expect(await run(t.transport)).toMatchObject({ status: "ok", tagged: 2, more: false });
    expect(t.prompts.map((p) => /zebra-(\d+)/.exec(p)![1])).toEqual(
      Array.from({ length: TICK_BATCH + 2 }, (_, n) => String(n + 1))
    );
    expect(SCAN_LIMIT).toBeGreaterThanOrEqual(TICK_BATCH);
  });

  it("stores an empty list as a finished answer and does not ask again", async () => {
    await reason(WORDS(1));
    const t = transport(() => '{"tags":[]}');
    expect(await run(t.transport)).toMatchObject({ status: "ok", tagged: 1 });
    expect((await tagRows())[0]!.attrs.tags).toEqual([]);
    expect(await run(t.transport)).toMatchObject({ status: "idle" });
    expect(t.prompts).toHaveLength(1);
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ tags: [], origin: "inferred", stale: false });
  });

  it("never lets one failing reason block the ones after it, and backs it off per reason", async () => {
    const bad = await reason(WORDS(1));
    const good = await reason(WORDS(2));
    const t = transport((prompt) => (prompt.includes(WORDS(1)) ? "not json at all" : TAGS));
    const first = await run(t.transport);
    expect(first).toMatchObject({ status: "failed", outcome: "bad_output", tagged: 0 });
    expect(await tagRows()).toHaveLength(0);
    // The next tick skips the failing reason and tags the one behind it.
    const second = await run(t.transport, 1000);
    expect(second).toMatchObject({ status: "ok", tagged: 1, more: false });
    expect((await tagRows()).map((row) => row.attrs.check_in_id)).toEqual([good]);
    // Still inside its wait: not asked again.
    const calls = t.prompts.length;
    expect(await run(t.transport, 2000)).toMatchObject({ status: "idle" });
    expect(t.prompts.length).toBe(calls);
    // After the wait it is tried again, and the wait grows each time up to the cap, then a day.
    let at = backoffMs(1) + 1000;
    for (let failures = 2; failures <= ATTEMPT_CAP + 1; failures += 1) {
      expect(await run(t.transport, at)).toMatchObject({ status: "failed", outcome: "bad_output" });
      expect([...attempts.values()][0]!.failures).toBe(failures);
      at += backoffMs(failures) + 1000;
    }
    expect(backoffMs(ATTEMPT_CAP)).toBe(86_400_000);
    expect(backoffMs(ATTEMPT_CAP + 5)).toBe(86_400_000);
    // When the model gets it right the reason is tagged and forgotten.
    const fixed = transport(() => TAGS);
    expect(await run(fixed.transport, at)).toMatchObject({ status: "ok", tagged: 1 });
    expect(attempts.size).toBe(0);
    expect((await tagRows()).map((row) => row.attrs.check_in_id).sort()).toEqual([bad, good].sort());
  });

  it("records a failure as a count and an outcome code, never with the words", async () => {
    await reason(WORDS(1));
    const out = await run(
      transport(() => ({ outcome: "unreachable", message: `could not reach it about ${WORDS(1)}` })).transport
    );
    expect(out).toMatchObject({ status: "failed", outcome: "unreachable" });
    expect(JSON.stringify(out)).not.toContain("zebra");
    expect(JSON.stringify([...attempts])).not.toContain("zebra");
    expect(JSON.stringify([...attempts])).not.toMatch(/kettle/);
    const thrown = {
      complete: vi.fn(async () => {
        throw new Error(`boom ${WORDS(1)}`);
      })
    } as unknown as ModelTransport;
    const crashed = await run(thrown, backoffMs(1) + 1000);
    expect(crashed).toMatchObject({ status: "failed" });
    expect(JSON.stringify(crashed)).not.toContain("zebra");
  });

  it("writes nothing to any log or error, and none of the words reach a stored model-call row", async () => {
    const seen: string[] = [];
    const spies = [
      vi.spyOn(console, "log").mockImplementation((...args) => void seen.push(args.join(" "))),
      vi.spyOn(console, "error").mockImplementation((...args) => void seen.push(args.join(" "))),
      vi.spyOn(console, "warn").mockImplementation((...args) => void seen.push(args.join(" "))),
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => (seen.push(String(chunk)), true)),
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (seen.push(String(chunk)), true))
    ];
    try {
      await reason(WORDS(1));
      await reason(WORDS(2));
      const t = transport((prompt) => (prompt.includes(WORDS(1)) ? "broken" : TAGS));
      await run(t.transport);
      await run(t.transport, 1000);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(seen.join("\n")).not.toMatch(/zebra|kettle/);
    const calls = await sql`SELECT * FROM derived_model_calls`;
    expect(JSON.stringify(calls)).not.toMatch(/zebra|kettle/);
  });

  it("does not ask about a reason the owner has answered, and asks again after a reset", async () => {
    const id = await reason(WORDS(1));
    await setReasonTags(sql, { checkInId: id, tags: ["mine"], reset: undefined, requestId: "req-aaaaaaaa" });
    const t = transport(() => TAGS);
    expect(await run(t.transport)).toMatchObject({ status: "idle" });
    expect(t.prompts).toHaveLength(0);
    await setReasonTags(sql, { checkInId: id, tags: undefined, reset: true, requestId: "req-bbbbbbbb" });
    expect(await run(t.transport)).toMatchObject({ status: "ok", tagged: 1 });
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({
      tags: ["kettle noise", "outside"],
      origin: "inferred"
    });
  });

  it("tags again for another model, keeping the earlier tags (marked stale) until the new ones land", async () => {
    const id = await reason(WORDS(1));
    await run(transport(() => '{"tags":["first model"]}').transport);
    await saveDerivedSettings(sql, { t2Model: "model:70b" });
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({
      tags: ["first model"],
      origin: "inferred",
      stale: true
    });
    await run(transport(() => '{"tags":["second model"]}').transport);
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ tags: ["second model"], stale: false });
    expect((await tagRows()).map((row) => row.event_key)).toEqual([
      `reason_tag|${id}|inferred|v1|model:8b`,
      `reason_tag|${id}|inferred|v1|model:70b`
    ]);
  });

  it("tags again for another prompt version, keeping the old tags until the new ones land", async () => {
    const id = await reason(WORDS(1));
    // A row left by an earlier wording of the prompt.
    await sql`INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_via)
      VALUES (${userId}, 'drift-reason', 'reason_tag', ${`reason_tag|${id}|inferred|v7|model:8b`}, now(),
        ${sql.json({ check_in_id: id, tags: ["old wording"], origin: "inferred", model: { id: "model:8b" }, prompt_version: 7 })},
        'drift:reason-tag')`;
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ tags: ["old wording"], stale: true });
    expect(await run(transport(() => TAGS).transport)).toMatchObject({ status: "ok", tagged: 1 });
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ tags: ["kettle noise", "outside"], stale: false });
    expect(await tagRows()).toHaveLength(2);
  });

  it("drops the tags when the words were saved again while the model worked, then tags the new words", async () => {
    const id = await reason(WORDS(1));
    let resaved = false;
    const t = transport(() => TAGS);
    const resaving = {
      complete: vi.fn(async (...args: Parameters<ModelTransport["complete"]>) => {
        if (!resaved) {
          resaved = true;
          await reason(WORDS(2), id);
        }
        return t.transport.complete(...args);
      })
    } as unknown as ModelTransport;
    expect(await run(resaving)).toMatchObject({ status: "discarded" });
    expect(await tagRows()).toHaveLength(0);
    expect(await run(t.transport)).toMatchObject({ status: "ok", tagged: 1 });
    expect(t.prompts.at(-1)).toContain(WORDS(2));
    expect(t.prompts.at(-1)).not.toContain(WORDS(1));
  });

  it("replaces tags made for earlier words when the words are saved again", async () => {
    const id = await reason(WORDS(1));
    await run(transport(() => '{"tags":["about the first"]}').transport);
    await reason(WORDS(2), id);
    // The first words' tags are not shown against the new words.
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ text: WORDS(2), tags: [], origin: null });
    await run(transport(() => '{"tags":["about the second"]}').transport);
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ tags: ["about the second"], origin: "inferred" });
    expect(await tagRows()).toHaveLength(1);
  });

  it("leaves reasons older than the window alone", async () => {
    await reason(WORDS(1), undefined, 20);
    const t = transport(() => TAGS);
    expect(await run(t.transport)).toMatchObject({ status: "idle" });
    expect(t.prompts).toHaveLength(0);
    expect((await readReasonTags(sql)).reasons).toEqual([]);
  });

  it("asks once when two runs overlap, and answers busy while another job holds the activity lock", async () => {
    await reason(WORDS(1));
    let release: () => void = () => {};
    const gate = new Promise<void>((done) => (release = done));
    const t = transport(() => TAGS);
    const slow = {
      complete: vi.fn(async (...args: Parameters<ModelTransport["complete"]>) => {
        await gate;
        return t.transport.complete(...args);
      })
    } as unknown as ModelTransport;
    const state = createPolicyState();
    const options = { now: () => new Date(clock), sleep: async () => {}, policyState: state, attempts };
    const first = runReasonTagTick(sql, { ...options, transport: slow });
    await vi.waitFor(() => expect(state.working.size).toBe(1));
    expect(await runReasonTagTick(sql, { ...options, transport: slow })).toMatchObject({ status: "idle" });
    release();
    expect(await first).toMatchObject({ status: "ok", tagged: 1 });

    await reason(WORDS(2));
    let result;
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`activity_store:${userId}`}, 0))`;
      result = await run(t.transport);
    });
    expect(result).toMatchObject({ status: "busy" });
  });
});

describe("the owner's tag corrections", () => {
  const set = (checkInId: string, tags: unknown, requestId: string, reset?: unknown) =>
    setReasonTags(sql, { checkInId, tags, reset, requestId });

  it("stores each change as a new row of the owner's own, and reads A, B, A back as A", async () => {
    const id = await reason(WORDS(1));
    expect(await set(id, ["a"], "req-aaaaaaaa")).toMatchObject({
      ok: true,
      reason: { tags: ["a"], origin: "corrected" }
    });
    await set(id, ["b"], "req-bbbbbbbb");
    const back = await set(id, ["a"], "req-cccccccc");
    expect(back).toMatchObject({ ok: true, reason: { tags: ["a"], origin: "corrected" } });
    const stored = await tagRows();
    expect(stored).toHaveLength(3);
    expect(stored.every((row) => row.ingested_via === null && row.attrs.origin === "corrected")).toBe(true);
    // A retry of the same change is the same row.
    await set(id, ["a"], "req-cccccccc");
    expect(await tagRows()).toHaveLength(3);
  });

  it("takes a reset as taking the answer back, so the model's tags show again, and leaves the model's rows as they were", async () => {
    const id = await reason(WORDS(1));
    await run(transport(() => TAGS).transport);
    const before = await tagRows();
    await set(id, [], "req-aaaaaaaa");
    expect((await readReasonTags(sql)).reasons[0]).toMatchObject({ tags: [], origin: "corrected" });
    const reset = await set(id, undefined, "req-bbbbbbbb", true);
    expect(reset).toMatchObject({ ok: true, reason: { tags: ["kettle noise", "outside"], origin: "inferred" } });
    expect((await tagRows()).filter((row) => row.ingested_via !== null)).toEqual(before);
  });

  it("folds typed tags, drops blanks and repeats, and refuses too many or too long ones without echoing them", async () => {
    const id = await reason(WORDS(1));
    expect(await set(id, ["  Loud  NOISE ", "loud noise", "   ", "Café"], "req-aaaaaaaa")).toMatchObject({
      ok: true,
      reason: { tags: ["loud noise", "café"] }
    });
    const many = await set(
      id,
      Array.from({ length: 7 }, (_, n) => `private ${n}`),
      "req-bbbbbbbb"
    );
    expect(many).toMatchObject({ ok: false, status: 400 });
    const long = await set(id, ["x".repeat(41)], "req-cccccccc");
    expect(long).toMatchObject({ ok: false, status: 400 });
    const control = await set(id, [`a${String.fromCharCode(0)}b`], "req-dddddddd");
    expect(control).toMatchObject({ ok: false, status: 400 });
    for (const refused of [many, long, control]) expect(JSON.stringify(refused)).not.toMatch(/private|xxxx/);
    expect(await set(id, "not a list", "req-eeeeeeee")).toMatchObject({ ok: false, status: 400 });
    expect(await set(id, ["a"], "x")).toMatchObject({ ok: false, status: 400 });
    expect(await set(id, ["a"], "req-ffffffff", "yes")).toMatchObject({ ok: false, status: 400 });
    expect(await set(id, ["a"], "req-gggggggg", true)).toMatchObject({ ok: false, status: 400 });
    expect(await tagRows()).toHaveLength(1);
  });

  it("refuses a reason that is not there, or an id that is not a check-in id", async () => {
    expect(await set("33333333-3333-4333-8333-333333333333", ["a"], "req-aaaaaaaa")).toMatchObject({
      ok: false,
      status: 404
    });
    expect(await set("nope", ["a"], "req-aaaaaaaa")).toMatchObject({ ok: false, status: 400 });
    expect(await tagRows()).toHaveLength(0);
  });

  it("lists the last 14 days newest first, keeps a reason whose check-in is gone, and removes tags with the reason", async () => {
    await reason(WORDS(1), undefined, 15);
    const kept = await reason(WORDS(2));
    const latest = await reason(WORDS(3));
    await set(latest, ["mine"], "req-aaaaaaaa");
    await sql`DELETE FROM check_in WHERE id = ${kept}`;
    const listed = await readReasonTags(sql);
    expect(listed.modelConfigured).toBe(true);
    expect(listed.reasons.map((item) => [item.checkInId, item.tags])).toEqual([
      [latest, ["mine"]],
      [kept, []]
    ]);
    expect(listed.reasons[0]).toMatchObject({ text: WORDS(3), origin: "corrected" });
    expect(await deleteReason(sql, latest)).toMatchObject({ ok: true, removed: 2 });
    expect((await tagRows()).length).toBe(0);
    expect((await readReasonTags(sql)).reasons.map((item) => item.checkInId)).toEqual([kept]);
  });
});

describe("what tags can reach", () => {
  /** Every table's rows as a digest, so any change anywhere shows. */
  async function snapshot() {
    const tables = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\\_\\_%'
      ORDER BY table_name`;
    const out: Record<string, string> = {};
    for (const { table_name } of tables) {
      const [row] = await sql.unsafe<{ digest: string }[]>(
        `SELECT md5(coalesce(string_agg(t::text, E'\\n' ORDER BY t::text), '')) AS digest FROM "${table_name}" t`
      );
      out[table_name] = row!.digest;
    }
    return out;
  }

  it("leave energy, sleep, availability, preferences, capacity and the write log exactly as they were; only the activity store gains rows", async () => {
    const id = await reason(WORDS(1));
    await reason(WORDS(2));
    const before = await snapshot();
    const t = transport(() => '{"tags":["tired","burnt out","low energy"]}');
    expect(await run(t.transport)).toMatchObject({ status: "ok", tagged: 2 });
    await setReasonTags(sql, { checkInId: id, tags: ["exhausted"], reset: undefined, requestId: "req-aaaaaaaa" });
    await setReasonTags(sql, { checkInId: id, tags: undefined, reset: true, requestId: "req-bbbbbbbb" });
    const after = await snapshot();
    const changed = Object.keys(after).filter((table) => after[table] !== before[table]);
    // The tick's call record and the activity store's own bookkeeping may change; nothing that plans may.
    expect(changed.filter((table) => !["activity_events", "activity_source_state"].includes(table))).toEqual([]);
    expect(changed).toContain("activity_events");
    expect((await sql`SELECT count(*)::int AS n FROM writes`)[0]).toMatchObject({ n: 0 });
  });

  it("show in no generic activity read, whatever scopes the reader holds", async () => {
    await reason(WORDS(1));
    await run(transport(() => TAGS).transport);
    const holder = withheldActivitySources(["read:activity-event", "read:activity-health", "read:activity-drift"]);
    for (const query of [{}, { excludeSources: holder }, { source: "drift-reason" }]) {
      const page = await readActivityEvents(sql, query);
      expect(JSON.stringify(page)).not.toMatch(/kettle|zebra/);
      expect(page.events.map((event) => event.source)).not.toContain("drift-reason");
    }
  });
});
