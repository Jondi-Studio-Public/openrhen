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
    const cut = await readEvalReport(sql, { window: 2 });
    expect(cut.versions[0]!.problems).toEqual([
      expect.stringContaining("Only the newest 2 fact rows of derived were looked at")
    ]);
    const whole = await readEvalReport(sql);
    expect(whole.versions[0]!.problems).toEqual([]);
    expect(whole.versions[0]!.report.wrongAutoActions.count).toBe(1);
  });

  it("takes the T0 share over the newest window of messages and says when the window cut some off", async () => {
    await state("1", true);
    const ids: string[] = [];
    for (const key of ["m1", "m2", "m3", "m4"]) {
      const id = await row("gmail", "message", key, at(Number(key.slice(1))), {});
      ids.push(id);
    }
    // m1 and m2 are the oldest; only m1 is classified.
    await classified("c1", ids[0]!, klass("m1", "bulk"));
    await classified("c4", ids[3]!, klass("m4", "bulk"));
    await label("l", at(9), { source_event_id: "m4", field: "class", answer: "bulk" });
    const narrow = (await readEvalReport(sql, { window: 2 })).versions[0]!;
    expect(narrow.report.t0).toMatchObject({ messages: 2, resolvedByT0: 1 });
    expect(narrow.problems).toEqual([expect.stringContaining("T0 share is over the newest 2 messages only")]);
    const whole = (await readEvalReport(sql)).versions[0]!;
    expect(whole.report.t0).toMatchObject({ messages: 4, resolvedByT0: 2 });
    expect(whole.problems).toEqual([]);
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

describe("readEvalReport: facts", () => {
  const micro = (date: Date) => date.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  const LOW = "00000000-0000-0000-0000-000000000000";
  const HIGH = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const factId = (n: number) => String(n).padStart(2, "0").repeat(20);
  const stateWith = (version: string, active: boolean, cursor: Record<string, unknown>) =>
    sql`INSERT INTO extractor_state (user_id, extractor, version, active, cursor)
        VALUES (${userId}, 'msg-class-t0', ${version}, ${active}, ${sql.json(cursor as never)})`;
  const messageAt = (key: string, minutes: number) => row("gmail", "message", key, at(minutes), {});
  const written = (
    n: number,
    message: string,
    type: string,
    version = "1",
    ingested = at(30),
    extra: Record<string, unknown> = {},
    source = "derived"
  ) =>
    row(
      source,
      "fact",
      `f${source}${version}${n}`,
      ingested,
      {
        source_event_id: message,
        fact_id: factId(n),
        fact_type: type,
        extractor: "msg-class-t0",
        extractor_version: version,
        ...extra
      },
      VIA
    );
  const typesLabel = (key: string, answer: unknown, slice: "random" | "stratified" = "random") =>
    label(`l-${key}`, at(40), { source_event_id: key, field: "fact_types", answer, slice });
  const typeOf = (report: Awaited<ReturnType<typeof readEvalReport>>, type: string, index = 0) =>
    report.versions[index]!.report.facts.types.find((t) => t.type === type)!;

  it("scores a version whose every fact type is right: full recall and precision, positives counted", async () => {
    await stateWith("1", true, { forward: { at: micro(at(60)), id: HIGH }, backfill: { at: micro(at(0)), id: LOW } });
    const cases: [string, string[]][] = [
      ["a", ["ask"]],
      ["b", ["commitment"]],
      ["c", ["event"]],
      ["d", ["deadline"]],
      ["e", []]
    ];
    let n = 1;
    for (const [key, types] of cases) {
      await messageAt(key, 10);
      await typesLabel(key, types);
      for (const type of types) await written(n++, key, type);
    }
    const report = await readEvalReport(sql);
    const facts = report.versions[0]!.report.facts;
    for (const type of ["ask", "commitment", "event", "deadline"])
      expect(typeOf(report, type)).toMatchObject({ randomPositives: 1, hits: 1, predicted: 1, correct: 1 });
    expect(facts.falseAlarms).toMatchObject({ labelledEmpty: 1, flagged: 0 });
    expect(facts).toMatchObject({ labelledMessages: 5, scored: 5, notReached: 0 });
    expect(report.versions[0]!.report.fields.map((f) => f.field)).not.toContain("fact_types");
    expect(report.versions[0]!.problems).toEqual([]);
  });

  it("scores misses, wrong types, false alarms and empty messages inside and outside the processed range", async () => {
    // Processed range: ingested at minutes 11 to 16. m10 and m17 were never reached.
    await stateWith("1", true, { forward: { at: micro(at(16)), id: HIGH }, backfill: { at: micro(at(11)), id: LOW } });
    for (const [key, minute] of [
      ["m10", 10],
      ["m11", 11],
      ["m12", 12],
      ["m13", 13],
      ["m14", 14],
      ["m15", 15],
      ["m16", 16],
      ["m17", 17]
    ] as const)
      await messageAt(key, minute);
    await typesLabel("m11", ["ask"]);
    await typesLabel("m12", ["ask", "deadline"]);
    await typesLabel("m13", ["event"]);
    await typesLabel("m14", []);
    await typesLabel("m15", []);
    await typesLabel("m16", ["commitment"]);
    await typesLabel("m10", []);
    await typesLabel("m17", ["ask"]);
    await written(1, "m11", "ask");
    await written(2, "m12", "ask");
    await written(3, "m13", "event");
    await written(4, "m15", "commitment");
    const report = await readEvalReport(sql);
    expect(typeOf(report, "ask")).toMatchObject({ randomPositives: 2, hits: 2, predicted: 2, correct: 2 });
    expect(typeOf(report, "deadline")).toMatchObject({ randomPositives: 1, hits: 0, predicted: 0 });
    expect(typeOf(report, "deadline").recall).toMatchObject({ value: 0 });
    expect(typeOf(report, "event")).toMatchObject({ randomPositives: 1, hits: 1 });
    expect(typeOf(report, "commitment")).toMatchObject({ randomPositives: 1, hits: 0, predicted: 1, correct: 0 });
    const facts = report.versions[0]!.report.facts;
    // m14 is a correct negative (inside the range), m15 a false alarm, m10 outside the range is not scored.
    expect(facts.falseAlarms).toMatchObject({ labelledEmpty: 2, flagged: 1 });
    expect(facts.falseAlarms.rate).toMatchObject({ value: 0.5 });
    expect(facts).toMatchObject({ labelledMessages: 8, scored: 6, notReached: 2 });
    expect(report.versions[0]!.problems).toEqual([
      expect.stringContaining("2 labelled message(s) are outside what this version has processed")
    ]);
  });

  it("scores nothing for a negative when the extractor has not run at all", async () => {
    await state("1", true);
    await messageAt("m1", 10);
    await typesLabel("m1", []);
    const report = await readEvalReport(sql);
    expect(report.versions[0]!.report.facts).toMatchObject({ scored: 0, notReached: 1 });
    expect(report.versions[0]!.report.facts.falseAlarms.rate).toBeNull();
  });

  it("scores a promoted version against labels made for the old one: shadow.done bounds it, the fallback join finds facts under new ids", async () => {
    await stateWith("1", true, { forward: { at: micro(at(60)), id: HIGH }, backfill: { at: micro(at(0)), id: LOW } });
    await stateWith("2", false, { shadow: { done: ["m1", "m2", "m3"] } });
    for (const key of ["m1", "m2", "m3", "m4"]) await messageAt(key, 10);
    await typesLabel("m1", ["ask"]);
    await typesLabel("m2", []);
    await typesLabel("m3", ["deadline"]);
    await typesLabel("m4", []);
    // The old version: one fact with a span.
    await written(1, "m1", "ask", "1", at(30), { span: { start: 100, end: 140, hash: "0".repeat(12) } });
    await label("lf", at(41), { fact_id: factId(1), field: "fact_type", answer: "ask", slice: "stratified" });
    // The candidate wrote the same sentence under a new id (a different span reading), a false alarm on m2, and missed m3.
    await row(
      "derived-shadow",
      "fact",
      "n1",
      at(31),
      {
        source_event_id: "m1",
        fact_id: factId(9),
        fact_type: "ask",
        span: { start: 110, end: 150, hash: "1".repeat(12) },
        extractor: "msg-class-t0",
        extractor_version: "2"
      },
      VIA
    );
    await row(
      "derived-shadow",
      "fact",
      "n2",
      at(31),
      {
        source_event_id: "m2",
        fact_id: factId(8),
        fact_type: "event",
        extractor: "msg-class-t0",
        extractor_version: "2"
      },
      VIA
    );
    const report = await readEvalReport(sql);
    const [active, shadow] = report.versions;
    expect(active!.active).toBe(true);
    expect(shadow).toMatchObject({ source: "derived-shadow", version: "2", active: false });
    // Exact id for the version that wrote the labelled fact, fallback for the candidate.
    expect(active!.report.facts.fallback).toEqual({ matched: 0, unmatched: 0 });
    expect(active!.report.fields.find((f) => f.field === "fact_type")).toMatchObject({ labelled: 1, correct: 1 });
    expect(shadow!.report.facts.fallback).toEqual({ matched: 1, unmatched: 0 });
    expect(shadow!.report.fields.find((f) => f.field === "fact_type")).toMatchObject({ labelled: 1, correct: 1 });
    // m1 hit, m3 missed (reached, no fact), m2 a false alarm, m4 never reached.
    expect(typeOf(report, "ask", 1)).toMatchObject({ randomPositives: 1, hits: 1 });
    expect(typeOf(report, "deadline", 1)).toMatchObject({ randomPositives: 1, hits: 0 });
    expect(shadow!.report.facts.falseAlarms).toMatchObject({ labelledEmpty: 1, flagged: 1 });
    expect(shadow!.report.facts).toMatchObject({ scored: 3, notReached: 1 });
    // The old version's rows are never read as the candidate's.
    expect(typeOf(report, "ask", 0)).toMatchObject({ predicted: 1 });
  });

  it("does not match a candidate fact to a labelled one when the spans do not overlap", async () => {
    await stateWith("1", true, { forward: { at: micro(at(60)), id: HIGH }, backfill: { at: micro(at(0)), id: LOW } });
    await stateWith("2", false, { shadow: { done: ["m1"] } });
    await messageAt("m1", 10);
    await written(1, "m1", "ask", "1", at(30), { span: { start: 0, end: 20, hash: "0".repeat(12) } });
    await label("lf", at(41), { fact_id: factId(1), field: "fact_type", answer: "ask" });
    await row(
      "derived-shadow",
      "fact",
      "n1",
      at(31),
      {
        source_event_id: "m1",
        fact_id: factId(9),
        fact_type: "ask",
        span: { start: 300, end: 340, hash: "1".repeat(12) },
        extractor: "msg-class-t0",
        extractor_version: "2"
      },
      VIA
    );
    const report = await readEvalReport(sql);
    expect(report.versions[1]!.report.facts.fallback).toEqual({ matched: 0, unmatched: 1 });
    expect(report.versions[1]!.report.fields.find((f) => f.field === "fact_type")).toMatchObject({
      labelled: 1,
      predicted: 0
    });
  });
});
