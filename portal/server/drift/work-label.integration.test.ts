import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { createPolicyState, type ModelOutcome, type ModelTransport } from "@/server/derived/call-policy";
import { saveDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readAreaSnapshots } from "@/server/persistence/postgres/work-label-store";
import { runWorkLabelTick } from "./work-label-runner";
import { readWorkLabels, setWorkLabel } from "./work-labels";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_work_label");
if (!adminUrl) throw new Error("POSTGRES_ADMIN_URL is required for PostgreSQL integration tests");
if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
  throw new Error("TEST_DATABASE_NAME must be an identifier ending in _test");
}
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${testDatabaseName}`;

let sql: postgres.Sql;
let userId: string;
let order = 0;

async function area(name: string, over: { private?: boolean; description?: string; status?: string } = {}) {
  order += 1;
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO areas (user_id, name, description, private, status, sort_order)
    VALUES (${userId}, ${name}, ${over.description ?? null}, ${over.private ?? false}, ${over.status ?? "active"}, ${order})
    RETURNING id`;
  return row!.id;
}
async function outcome(areaId: string, title: string) {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO outcomes (area_id, title, definition_of_done) VALUES (${areaId}, ${title}, 'done') RETURNING id`;
  return row!.id;
}
async function project(outcomeId: string, title: string, isPrivate = false, status = "active") {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO projects (outcome_id, title, private, status) VALUES (${outcomeId}, ${title}, ${isPrivate}, ${status}) RETURNING id`;
  return row!.id;
}
async function action(projectId: string, title: string, isPrivate = false) {
  await sql`
    INSERT INTO actions (project_id, title, private, energy, minimum_session_minutes, maximum_session_minutes, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes)
    VALUES (${projectId}, ${title}, ${isPrivate}, 'medium', 5, 60, 10, 20, 30, 20)`;
}
const rows = () =>
  sql<{ event_key: string; attrs: Record<string, unknown>; ingested_via: string | null }[]>`
    SELECT event_key, attrs, ingested_via FROM activity_events WHERE source = 'drift' ORDER BY ts_start, event_key`;

/** A transport that answers every call with one reply and records the prompts it was shown. */
function transport(reply: string | ModelOutcome) {
  const prompts: string[] = [];
  const complete = vi.fn(async (_tier: string, request: { messages: { content: string }[] }): Promise<ModelOutcome> => {
    prompts.push(request.messages.map((message) => message.content).join("\n"));
    return typeof reply === "string"
      ? { outcome: "ok", text: reply, model: "model:8b", tokensIn: 1, tokensOut: 1 }
      : reply;
  });
  return { transport: { complete } as unknown as ModelTransport, prompts, complete };
}
const run = (t: ModelTransport, now = new Date("2026-11-09T10:00:00.000Z")) =>
  runWorkLabelTick(sql, {
    now: () => now,
    transport: t,
    sleep: async () => {},
    policyState: createPolicyState(),
    newBoundary: () => "b".repeat(24)
  });
const WORK = '{"label":"work","evidence":"a paid course"}';

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
});

afterAll(async () => {
  await sql.end();
});

describe("what the model may see", () => {
  it("drops private areas, private projects and actions, actions under a private project, and closed items", async () => {
    const open = await area("Synthetic Study", { description: "coursework" });
    const hidden = await area("Synthetic Hidden", { private: true });
    const o = await outcome(open, "Pass the unit");
    const p = await project(o, "Public project");
    const secret = await project(o, "Private project title", true);
    const done = await project(o, "Finished project", false, "done");
    await action(p, "Public action");
    await action(p, "Private action title", true);
    await action(secret, "Action under private project");
    await action(done, "Action under finished project");
    const ho = await outcome(hidden, "Hidden outcome");
    await action(await project(ho, "Hidden project"), "Hidden action");

    const snapshots = await readAreaSnapshots(sql, userId);
    expect(snapshots.map((snapshot) => snapshot.name)).toEqual(["Synthetic Study"]);
    const text = JSON.stringify(snapshots);
    for (const leak of [
      "Private project",
      "Private action",
      "Hidden",
      "under private project",
      "Finished project",
      "finished project"
    ])
      expect(text).not.toContain(leak);
    expect(snapshots[0]!.titles).toEqual(["Pass the unit", "Public project", "Public action"]);
  });
});

describe("the owner's answer", () => {
  it("is stored as the owner's row, wins, can be reset, and is one row per request", async () => {
    const id = await area("Synthetic Reading");
    const first = await setWorkLabel(sql, { areaId: id, label: "work", requestId: "req-aaaaaaaa" });
    expect(first).toMatchObject({ ok: true, label: { areaId: id, value: "work", origin: "corrected" } });
    const [stored] = await rows();
    expect(stored).toMatchObject({ ingested_via: null, attrs: { origin: "corrected", label: "work" } });

    await setWorkLabel(sql, { areaId: id, label: "work", requestId: "req-aaaaaaaa" });
    expect(await rows()).toHaveLength(1);

    await setWorkLabel(sql, { areaId: id, label: "not_work", requestId: "req-bbbbbbbb" });
    expect((await readWorkLabels(sql)).labels).toMatchObject([{ areaId: id, value: "not_work", origin: "corrected" }]);

    const reset = await setWorkLabel(sql, { areaId: id, label: "unset", requestId: "req-cccccccc" });
    expect(reset).toMatchObject({ ok: true, label: { value: "unknown", origin: null } });
  });

  it("refuses an unknown area, a bad label and a bad request id, naming the fix", async () => {
    const id = await area("Synthetic Reading");
    expect(
      await setWorkLabel(sql, {
        areaId: "00000000-0000-0000-0000-000000000000",
        label: "work",
        requestId: "req-aaaaaaaa"
      })
    ).toMatchObject({ ok: false, status: 404 });
    expect(await setWorkLabel(sql, { areaId: id, label: "maybe", requestId: "req-aaaaaaaa" })).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("label must be one of")
    });
    expect(await setWorkLabel(sql, { areaId: id, label: "work", requestId: "x" })).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("requestId")
    });
    expect(await rows()).toHaveLength(0);
  });

  it("lets the owner answer for a private area, which the model never sees", async () => {
    const id = await area("Synthetic Hidden", { private: true });
    expect(await setWorkLabel(sql, { areaId: id, label: "work", requestId: "req-aaaaaaaa" })).toMatchObject({
      ok: true,
      label: { value: "work", origin: "corrected" }
    });
  });
});

describe("runWorkLabelTick", () => {
  it("says it is not configured, and does nothing, with no local model", async () => {
    await saveDerivedSettings(sql, { t2Model: null });
    await area("Synthetic Study");
    const t = transport(WORK);
    expect(await run(t.transport)).toMatchObject({ status: "not_configured", more: false });
    expect(t.complete).not.toHaveBeenCalled();
  });

  it("labels one area at a time, stores the model's row as inferred with its stamp, and goes idle", async () => {
    const a = await area("Synthetic Study");
    await outcome(a, "Pass the unit");
    await area("Synthetic Garden");
    const t = transport(WORK);
    const first = await run(t.transport);
    expect(first).toMatchObject({ status: "ok", more: true, label: "work" });
    expect(JSON.stringify(first)).not.toMatch(/Synthetic|Pass the unit/);
    const [stored] = await rows();
    expect(stored!.ingested_via).toBe("drift:label");
    expect(stored!.attrs).toMatchObject({
      origin: "inferred",
      label: "work",
      model: { id: "model:8b" },
      prompt_version: 1,
      evidence: "a paid course"
    });
    expect(stored!.attrs.input_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("Pass the unit");
    expect(await run(t.transport)).toMatchObject({ status: "ok", more: false });
    expect(await run(t.transport)).toMatchObject({ status: "idle" });
    expect(await rows()).toHaveLength(2);
    expect((await readWorkLabels(sql)).labels).toHaveLength(2);
  });

  it("never puts a private project, a private area or the owner's other text in the prompt", async () => {
    const open = await area("Synthetic Study");
    const o = await outcome(open, "Pass the unit");
    await project(o, "Private project title", true);
    await area("Synthetic Hidden", { private: true });
    const t = transport(WORK);
    await run(t.transport);
    await run(t.transport);
    const shown = t.prompts.join("\n");
    expect(shown).toContain("Synthetic Study");
    expect(shown).not.toMatch(/Private project|Hidden/);
  });

  it("asks again when the text changes, and reads the first label again when the text reverts (A, B, A)", async () => {
    const id = await area("Synthetic Study");
    const o = await outcome(id, "Pass the unit");
    const replies = [WORK, '{"label":"not_work","evidence":"hobby"}'];
    let call = 0;
    const complete = vi.fn(async (): Promise<ModelOutcome> => ({
      outcome: "ok",
      text: call % 2 === 0 ? replies[0]! : replies[1]!,
      model: "m",
      tokensIn: 1,
      tokensOut: 1
    }));
    const t = { complete } as unknown as ModelTransport;
    // A
    await run(t);
    call += 1;
    expect((await readWorkLabels(sql)).labels[0]).toMatchObject({ value: "work", origin: "inferred" });
    // B: the text changes, so there is no label for it until the model answers.
    await sql`UPDATE outcomes SET title = 'Plant the beds' WHERE id = ${o}`;
    expect((await readWorkLabels(sql)).labels).toMatchObject([{ value: "unknown", origin: null }]);
    await run(t);
    expect((await readWorkLabels(sql)).labels[0]).toMatchObject({ value: "not_work", origin: "inferred" });
    // A again: the first row is still held, no new call, and its label counts again.
    await sql`UPDATE outcomes SET title = 'Pass the unit' WHERE id = ${o}`;
    const calls = complete.mock.calls.length;
    expect(await run(t)).toMatchObject({ status: "idle" });
    expect(complete.mock.calls.length).toBe(calls);
    expect((await readWorkLabels(sql)).labels[0]).toMatchObject({ value: "work", origin: "inferred" });
  });

  it("does not ask about an area the owner has answered", async () => {
    const id = await area("Synthetic Study");
    await setWorkLabel(sql, { areaId: id, label: "not_work", requestId: "req-aaaaaaaa" });
    const t = transport(WORK);
    expect(await run(t.transport)).toMatchObject({ status: "idle" });
    expect(t.complete).not.toHaveBeenCalled();
    // After a reset it is the model's turn.
    await setWorkLabel(sql, { areaId: id, label: "unset", requestId: "req-bbbbbbbb" });
    expect(await run(t.transport)).toMatchObject({ status: "ok" });
  });

  it("still honours an old owner answer after more than 5000 newer inferred rows", async () => {
    const id = await area("Synthetic Study");
    const other = await area("Synthetic Other");
    await setWorkLabel(sql, { areaId: id, label: "not_work", requestId: "req-aaaaaaaa" });
    expect(await run(transport(WORK).transport)).toMatchObject({ status: "ok" });
    await sql`
      INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, ts_end, tz_offset_min, attrs, content, ingested_via, ingested_at)
      SELECT user_id, source, kind, event_key || '|bulk' || n, ts_start + interval '10 years' + make_interval(secs => n), ts_end + interval '10 years' + make_interval(secs => n), tz_offset_min, attrs, content, ingested_via, ingested_at
      FROM activity_events, generate_series(1, 5100) AS n
      WHERE source = 'drift' AND ingested_via IS NOT NULL`;
    const labels = (await readWorkLabels(sql)).labels;
    expect(labels.find((l) => l.areaId === id)).toMatchObject({ value: "not_work", origin: "corrected" });
    expect(labels.find((l) => l.areaId === other)).toMatchObject({ origin: "inferred" });
  });

  it("keeps nothing and leaves no area text in the answer when the model fails or answers badly", async () => {
    await area("Synthetic Study");
    const unreachable = transport({ outcome: "unreachable", message: "The local model could not be reached." });
    const failed = await run(unreachable.transport);
    expect(failed).toMatchObject({ status: "failed", outcome: "unreachable" });
    expect(JSON.stringify(failed)).not.toContain("Synthetic");
    const bad = transport("not json at all");
    expect(await run(bad.transport)).toMatchObject({ status: "failed", outcome: "bad_output" });
    expect(await run(transport('{"label":"maybe"}').transport)).toMatchObject({ status: "failed" });
    expect(await rows()).toHaveLength(0);
    expect(await run(transport(WORK).transport)).toMatchObject({ status: "ok" });
  });

  it("drops the answer when the area changed, or became private, while the model was working", async () => {
    const id = await area("Synthetic Study");
    const changing = {
      complete: vi.fn(async (): Promise<ModelOutcome> => {
        await sql`UPDATE areas SET name = 'Synthetic Renamed' WHERE id = ${id}`;
        return { outcome: "ok", text: WORK, model: "m", tokensIn: 1, tokensOut: 1 };
      })
    } as unknown as ModelTransport;
    expect(await run(changing)).toMatchObject({ status: "discarded" });
    expect(await rows()).toHaveLength(0);
    const hiding = {
      complete: vi.fn(async (): Promise<ModelOutcome> => {
        await sql`UPDATE areas SET private = true WHERE id = ${id}`;
        return { outcome: "ok", text: WORK, model: "m", tokensIn: 1, tokensOut: 1 };
      })
    } as unknown as ModelTransport;
    expect(await run(hiding)).toMatchObject({ status: "discarded" });
    expect(await rows()).toHaveLength(0);
  });

  it("answers busy, calling nothing, while another job holds the activity lock", async () => {
    await area("Synthetic Study");
    const t = transport(WORK);
    let result;
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`activity_store:${userId}`}, 0))`;
      result = await run(t.transport);
    });
    expect(result).toMatchObject({ status: "busy" });
    expect(t.complete).not.toHaveBeenCalled();
  });
});
