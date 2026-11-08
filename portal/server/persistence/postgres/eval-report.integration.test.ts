import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { resolve } from "node:path";
import { integrationDatabaseName } from "@openrhen/database";
import { ensureUser } from "./ensure-user";
import { readEvalReport } from "./eval-report-store";

config({ path: resolve(process.cwd(), "../.env"), quiet: true });

const adminUrl = process.env.POSTGRES_ADMIN_URL;
const testDatabaseName = integrationDatabaseName(process.env.TEST_DATABASE_NAME, "openrhen_eval_report");

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
  sql = postgres(testUrl.toString(), { max: 5, connect_timeout: 10, fetch_types: false });
}, 60_000);

beforeEach(async () => {
  await sql.unsafe("TRUNCATE TABLE users RESTART IDENTITY CASCADE");
  userId = await ensureUser(sql);
});

afterAll(async () => {
  await sql?.end();
});

const T = new Date("2026-11-08T00:00:00.000Z");
const at = (minutes: number) => new Date(T.getTime() + minutes * 60_000);
const FACT = "a".repeat(40);

async function row(
  source: string,
  kind: string,
  key: string,
  ingested: Date,
  attrs: Record<string, unknown>,
  via: string | null = null,
  user = userId
): Promise<string> {
  const [made] = await sql<{ id: string }[]>`
    INSERT INTO activity_events (user_id, source, kind, event_key, ts_start, attrs, ingested_at, ingested_via)
    VALUES (${user}, ${source}, ${kind}, ${key}, '2026-11-01T00:00:00Z', ${sql.json(attrs as never)}, ${ingested}, ${via})
    RETURNING id`;
  return made!.id;
}
const mail = (key: string) => row("gmail", "message", key, at(0), {});
const klass = (message: string, cls: string, version = "1", tier = "t0") => ({
  source_event_id: message,
  class: cls,
  reasons: [],
  tier,
  extractor: "msg-class-t0",
  extractor_version: version
});
const VIA = "extractor:msg-class-t0";
/** A msg_class row linked to the mail it was read from, as the runner writes it. */
async function classified(
  key: string,
  mailId: string,
  attrs: Record<string, unknown>,
  ingested = at(1),
  source = "derived"
): Promise<void> {
  const id = await row(source, "msg_class", key, ingested, attrs, VIA);
  await sql`INSERT INTO derived_lineage (user_id, derived_id, source_id) VALUES (${userId}, ${id}, ${mailId})`;
}
const state = (version: string, active: boolean) =>
  sql`INSERT INTO extractor_state (user_id, extractor, version, active) VALUES (${userId}, 'msg-class-t0', ${version}, ${active})`;
const label = (key: string, ingested: Date, attrs: Record<string, unknown>, via: string | null = null) =>
  row("derived", "label", key, ingested, attrs, via);

describe("readEvalReport", () => {
  it("is empty and honest with nothing labelled", async () => {
    const report = await readEvalReport(sql);
    expect(report).toMatchObject({ labels: { total: 0, ignored: 0 }, versions: [] });
    expect(report.caveat).toMatch(/gross failure only/);
    expect(report.backfill).toBeUndefined();
  });

  it("scores the active version against the person's labels: precision on all, recall on the random slice", async () => {
    await state("1", true);
    const [m1, m2, m3] = [await mail("m1"), await mail("m2"), await mail("m3")];
    await mail("m4");
    await classified("c1", m1, klass("m1", "bulk"));
    await classified("c2", m2, klass("m2", "person"));
    await classified("c3", m3, klass("m3", "bulk"));
    await label("l1", at(5), { source_event_id: "m1", field: "class", answer: "bulk", slice: "random" });
    await label("l2", at(5), { source_event_id: "m2", field: "class", answer: "bulk", slice: "random" });
    await label("l3", at(5), { source_event_id: "m3", field: "class", answer: "bulk", slice: "stratified" });
    await label("l4", at(5), { source_event_id: "m4", field: "class", answer: "person", slice: "random" });
    const report = await readEvalReport(sql);
    expect(report.labels).toEqual({ total: 4, unfielded: 0, ignored: 0 });
    expect(report.versions).toHaveLength(1);
    const version = report.versions[0]!;
    expect(version).toMatchObject({
      source: "derived",
      extractor: "msg-class-t0",
      version: "1",
      active: true,
      problems: []
    });
    const field = version.report.fields.find((f) => f.field === "class")!;
    expect(field).toMatchObject({
      labelled: 4,
      predicted: 3,
      correct: 2,
      randomLabelled: 3,
      randomPresent: 3,
      randomCorrect: 1
    });
    expect(version.report.t0).toMatchObject({ messages: 4, resolvedByT0: 3 });
  });

  it("keeps the earliest slice when a message is labelled again without one", async () => {
    await state("1", true);
    const m1 = await mail("m1");
    await classified("c1", m1, klass("m1", "bulk"));
    await label("first", at(5), { source_event_id: "m1", field: "class", answer: "person", slice: "random" });
    await label("again", at(6), { source_event_id: "m1", field: "class", answer: "bulk" });
    const field = (await readEvalReport(sql)).versions[0]!.report.fields[0]!;
    expect(field).toMatchObject({ labelled: 1, correct: 1, randomLabelled: 1, randomCorrect: 1 });
  });

  it("counts the T0 share over messages still held: purged mail leaves the numerator and the denominator together", async () => {
    await state("1", true);
    const ids = [await mail("m1"), await mail("m2"), await mail("m3"), await mail("m4")];
    for (const [index, id] of ids.entries()) await classified(`c${index}`, id, klass(`m${index + 1}`, "bulk"));
    await mail("m5");
    expect((await readEvalReport(sql)).versions).toHaveLength(1);
    await label("l", at(5), { source_event_id: "m1", field: "class", answer: "bulk" });
    const before = (await readEvalReport(sql)).versions[0]!.report.t0!;
    expect(before).toMatchObject({ messages: 5, resolvedByT0: 4 });
    // Retention deletes two classified messages (their lineage goes with them; the derived rows stay).
    await sql`DELETE FROM activity_events WHERE event_key IN ('m3', 'm4') AND source = 'gmail'`;
    const after = (await readEvalReport(sql)).versions[0]!.report.t0!;
    expect(after).toMatchObject({ messages: 3, resolvedByT0: 2 });
    expect(after.share).toBeLessThanOrEqual(1);
    expect(await sql`SELECT 1 FROM activity_events WHERE source = 'derived' AND kind = 'msg_class'`).toHaveLength(4);
  });

  it("does not score a label about mail that has since been deleted, and says how many", async () => {
    await state("1", true);
    const [m1, m2] = [await mail("m1"), await mail("m2")];
    await classified("c1", m1, klass("m1", "bulk"));
    await classified("c2", m2, klass("m2", "bulk"));
    await label("l1", at(5), { source_event_id: "m1", field: "class", answer: "bulk", slice: "random" });
    await label("l2", at(5), { source_event_id: "m2", field: "class", answer: "bulk", slice: "random" });
    await sql`DELETE FROM activity_events WHERE event_key = 'm2' AND source = 'gmail'`;
    const version = (await readEvalReport(sql)).versions[0]!;
    expect(version.report.fields[0]).toMatchObject({ labelled: 1, correct: 1 });
    expect(version.problems).toEqual([
      expect.stringContaining("1 label(s) are about mail that has since been deleted")
    ]);
  });

  it("counts a label only from the person: a token's or Mark's label is ignored, and shadow holds no labels at all", async () => {
    await state("1", true);
    const m1 = await mail("m1");
    await classified("c1", m1, klass("m1", "bulk"));
    await label("mine", at(5), { source_event_id: "m1", field: "class", answer: "bulk", slice: "random" });
    await label("marks", at(6), { source_event_id: "m1", field: "class", answer: "person", slice: "random" }, "mark");
    await label(
      "token",
      at(7),
      { source_event_id: "m1", field: "class", answer: "person", slice: "random" },
      "other-agent"
    );
    // A shadow-source label row (which the registry no longer lets anyone store) would still not be read.
    await row("derived-shadow", "label", "shadowed", at(8), {
      source_event_id: "m1",
      field: "class",
      answer: "person"
    });
    const report = await readEvalReport(sql);
    expect(report.labels).toEqual({ total: 1, unfielded: 0, ignored: 2 });
    expect(report.versions[0]!.report.fields[0]).toMatchObject({ labelled: 1, correct: 1 });
  });

  it("counts a legacy label with no field as unfielded and does not score it", async () => {
    await state("1", true);
    await label("nofield", at(5), { source_event_id: "m1", answer: "bulk" });
    expect((await readEvalReport(sql)).labels).toEqual({ total: 1, unfielded: 1, ignored: 0 });
  });

  it("reports a derived-shadow version beside the active one, and never reads an inactive version's derived rows", async () => {
    await state("1", true);
    await state("2", false);
    const m1 = await mail("m1");
    await classified("a1", m1, klass("m1", "bulk", "1"));
    await classified("old", m1, klass("m1", "person", "0"));
    await classified("s2", m1, klass("m1", "person", "2"), at(2), "derived-shadow");
    await label("l1", at(5), { source_event_id: "m1", field: "class", answer: "person", slice: "random" });
    const report = await readEvalReport(sql);
    expect(report.versions.map((v) => `${v.source}:${v.version}:${v.active}`)).toEqual([
      "derived:1:true",
      "derived-shadow:2:false"
    ]);
    const [active, shadow] = report.versions;
    expect(active!.report.fields[0]).toMatchObject({ correct: 0, predicted: 1 });
    expect(shadow!.report.fields[0]).toMatchObject({ correct: 1, predicted: 1 });
  });

  it("scores a reasons label as a set, so the order the codes are listed in does not matter", async () => {
    await state("1", true);
    const m1 = await mail("m1");
    await classified("c1", m1, { ...klass("m1", "bulk"), reasons: ["list_id", "unsubscribe_header"] });
    await label("l1", at(5), { source_event_id: "m1", field: "reasons", answer: ["unsubscribe_header", "list_id"] });
    expect((await readEvalReport(sql)).versions[0]!.report.fields[0]).toMatchObject({ field: "reasons", correct: 1 });
  });

  it("counts a wrong auto action: a value the extractor wrote that the person later labelled or overrode differently", async () => {
    await state("1", true);
    const [m1, m2] = [await mail("m1"), await mail("m2")];
    await classified("c1", m1, klass("m1", "bulk"));
    await classified("c2", m2, klass("m2", "bulk"));
    await row(
      "derived",
      "fact",
      "f1",
      at(1),
      { source_event_id: "m3", fact_id: FACT, fact_type: "ask", extractor: "msg-class-t0", extractor_version: "1" },
      VIA
    );
    await label("l1", at(5), { source_event_id: "m1", field: "class", answer: "person" });
    await label("l2", at(5), { source_event_id: "m2", field: "class", answer: "bulk" });
    await row("derived", "override", "o1", at(6), { fact_id: FACT, field: "fact_type", new_value: "deadline" });
    // Mark's override and a label made before the write do not count.
    await row("derived", "override", "o2", at(7), { fact_id: FACT, field: "who", new_value: "x" }, "mark");
    await label("early", at(0), { source_event_id: "m2", field: "tier", answer: "t1" });
    const wrong = (await readEvalReport(sql)).versions[0]!.report.wrongAutoActions;
    expect(wrong.count).toBe(2);
    expect(wrong.truncated).toBe(false);
    expect(
      wrong.items.map((i) => `${i.subject.kind}:${i.field}:${String(i.written)}>${String(i.corrected)}`).sort()
    ).toEqual(["fact:fact_type:ask>deadline", "message:class:bulk>person"]);
  });

  it("says when the fact read was cut short by its scan cap", async () => {
    await state("1", true);
    for (const id of ["1", "2", "3"])
      await row(
        "derived",
        "fact",
        `f${id}`,
        at(Number(id)),
        {
          source_event_id: "m",
          fact_id: id.repeat(40).slice(0, 40),
          fact_type: "ask",
          extractor: "msg-class-t0",
          extractor_version: "1"
        },
        VIA
      );
    await row("derived", "override", "o1", at(9), {
      fact_id: "1".repeat(40),
      field: "fact_type",
      new_value: "deadline"
    });
    const cut = await readEvalReport(sql, { factScanCap: 2 });
    expect(cut.versions[0]!.problems).toEqual([expect.stringContaining("Only the newest 2 fact rows")]);
    const whole = await readEvalReport(sql);
    expect(whole.versions[0]!.problems).toEqual([]);
    expect(whole.versions[0]!.report.wrongAutoActions.count).toBe(1);
  });

  it("never counts source_gone as a wrong action, but counts another status an extractor wrote that the person changed", async () => {
    const gone = { fact_id: FACT, status: "source_gone", valid_from: at(1).toISOString() };
    await row("derived", "fact_status", "gone", at(1), gone, "extractor:retention");
    await row("derived", "fact_status", "mine", at(2), {
      fact_id: FACT,
      status: "done",
      valid_from: at(2).toISOString()
    });
    expect((await readEvalReport(sql)).extractorStatuses.wrongAutoActions.count).toBe(0);
    const other = "b".repeat(40);
    await row(
      "derived",
      "fact_status",
      "prop",
      at(3),
      { fact_id: other, status: "proposed", valid_from: at(3).toISOString() },
      "extractor:x"
    );
    await row("derived", "fact_status", "mine2", at(4), {
      fact_id: other,
      status: "done",
      valid_from: at(4).toISOString()
    });
    expect((await readEvalReport(sql)).extractorStatuses.wrongAutoActions.count).toBe(1);
  });

  it("adds a backfill estimate over the raw rows still held when tokens and seconds per message are given, and not otherwise", async () => {
    await state("1", true);
    for (const key of ["m1", "m2", "m3", "m4"]) await mail(key);
    const plain = await readEvalReport(sql);
    expect(plain.backfill).toBeUndefined();
    const sized = await readEvalReport(sql, { backfill: { tokensPerMessage: 1000, secondsPerMessage: 2 } });
    expect(sized.backfill).toEqual([
      {
        source: "gmail",
        kind: "message",
        messages: 4,
        estimate: {
          messages: 4,
          modelMessages: 4,
          totalTokens: 4000,
          totalSeconds: 8,
          totalHours: 8 / 3600,
          usd: null
        },
        // Nothing is resolved by headers yet, so taking the T0 share out changes nothing.
        afterT0: expect.objectContaining({ modelMessages: 4, totalTokens: 4000 })
      }
    ]);
    // With a T0 share, the estimate after T0 leaves out the messages headers resolve.
    const [m1, m2] = [
      await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE event_key = 'm1'`,
      await sql<{ id: string }[]>`SELECT id FROM activity_events WHERE event_key = 'm2'`
    ];
    await classified("c1", m1[0]!.id, klass("m1", "bulk"));
    await classified("c2", m2[0]!.id, klass("m2", "bulk"));
    const after = (await readEvalReport(sql, { backfill: { tokensPerMessage: 1000, secondsPerMessage: 2 } }))
      .backfill![0]!;
    expect(after.afterT0).toMatchObject({ messages: 4, modelMessages: 2, totalTokens: 2000 });
  });

  it("is per person: another person's labels and rows never enter the report", async () => {
    const other = (await sql<{ id: string }[]>`INSERT INTO users (display_name) VALUES ('Other') RETURNING id`)[0]!.id;
    await row(
      "derived",
      "label",
      "theirs",
      at(5),
      { source_event_id: "m1", field: "class", answer: "bulk" },
      null,
      other
    );
    expect((await readEvalReport(sql)).labels.total).toBe(0);
  });
});
