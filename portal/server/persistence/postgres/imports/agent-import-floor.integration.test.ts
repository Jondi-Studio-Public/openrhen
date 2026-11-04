import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { parseImportCsv } from "@/features/imports/import-csv";
import { runWithActor } from "@/server/agent-actor";
import { ForbiddenCommandError } from "../command-errors";
import { fixedNow, importStore, setupStateStoreSuite, sql, store } from "../state-store-harness";

/**
 * The hard floor on an agent's import commit: a batch over the bulk
 * threshold, or one that changes a commitment on the family calendar, is the person's to commit. The batch stays
 * a draft, and the person's own commit of the same batch goes through.
 */
setupStateStoreSuite("openrhen_agent_import_floor");

const asAgent = <T>(fn: () => Promise<T>) => runWithActor("claude", fn);

const starts = new Date(fixedNow.getTime() + 26 * 60 * 60_000).toISOString();
const ends = new Date(fixedNow.getTime() + 28 * 60 * 60_000).toISOString();
const commitments = (csv: string) =>
  importStore.preview({
    sourceType: "csv",
    inputKind: "capacity_commitments",
    timezone: "Australia/Sydney",
    templateVersion: "1",
    records: parseImportCsv(
      "fixed_commitments",
      `import_key,title,starts_at,ends_at,status,setup_before_minutes,transition_after_minutes\r\n${csv}`
    ),
    source: {}
  });
const row = (key: string, title = "Lecture") => `${key},${title},${starts},${ends},confirmed,0,0`;
const status = async (id: string) =>
  (await sql<{ status: string }[]>`SELECT status FROM import_batches WHERE id=${id}`)[0]!.status;

describe("an agent's import commit", () => {
  it("commits a small batch that touches no one", async () => {
    await store.put(createSeedState(fixedNow));
    const batch = await commitments(row("lecture"));
    await asAgent(() => importStore.commit(batch.id, batch.version));
    expect(await status(batch.id)).toBe("committed");
  });

  it("is refused over the bulk threshold, for a full and a ready-only commit, and the person can commit it", async () => {
    await store.put(createSeedState(fixedNow));
    const batch = await commitments(
      Array.from({ length: 21 }, (_, index) => row(`lecture-${index}`, `Lecture ${index}`)).join("\r\n")
    );
    await expect(asAgent(() => importStore.commit(batch.id, batch.version))).rejects.toThrow(ForbiddenCommandError);
    await expect(asAgent(() => importStore.commitReady(batch.id, batch.version))).rejects.toThrow(/bulk: 21 rows/);
    expect(await status(batch.id)).not.toBe("committed");
    await importStore.commit(batch.id, batch.version);
    expect(await status(batch.id)).toBe("committed");
  });

  it("is refused when it changes a commitment already on the family calendar", async () => {
    await store.put(createSeedState(fixedNow));
    const created = await commitments(row("lecture"));
    await importStore.commit(created.id, created.version);
    await sql`UPDATE commitments SET share_to_calendar=true WHERE title='Lecture'`;
    const moved = await commitments(row("lecture", "Lecture moved"));
    expect(moved.records[0]?.operation).toBe("update");
    await expect(asAgent(() => importStore.commit(moved.id, moved.version))).rejects.toThrow(/touches another person/);
    expect((await sql<{ title: string }[]>`SELECT title FROM commitments WHERE share_to_calendar`)[0]?.title).toBe(
      "Lecture"
    );
  });

  describe("the hourly close brake", () => {
    const cancelRow = (key: string, title = "Lecture") => `${key},${title},${starts},${ends},cancelled,0,0`;
    const asTokenAgent = <T>(fn: () => Promise<T>) =>
      runWithActor("claude", fn, undefined, undefined, ["write:import"]);
    const spend = async (closed: number) => {
      const writeId = crypto.randomUUID();
      const userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
      await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${writeId},${userId},'close_entity','claude')`;
      await sql`INSERT INTO write_rows (write_id,user_id,entity_type,entity_id,operation,evidence) VALUES (${writeId},${userId},'action','seed','close',${sql.json({ closed, counted: true } as never)})`;
    };
    const seedCommitments = async (n: number) => {
      const created = await commitments(
        Array.from({ length: n }, (_, i) => row(`l-${i}`, `Lecture ${i}`)).join("\r\n")
      );
      await importStore.commit(created.id, created.version);
    };

    it("refuses a cancelling import that would pass 20 closures in the hour, and records one that fits", async () => {
      await store.put(createSeedState(fixedNow));
      await seedCommitments(4);
      await spend(18);
      const batch = await commitments(
        Array.from({ length: 3 }, (_, i) => cancelRow(`l-${i}`, `Lecture ${i}`)).join("\r\n")
      );
      expect(batch.records.map((r) => r.operation)).toEqual(["update", "update", "update"]);
      await expect(asTokenAgent(() => importStore.commit(batch.id, batch.version))).rejects.toThrow(
        /21 closures by agents in the last hour/
      );
      expect(await status(batch.id)).not.toBe("committed");
      // the owner is not held to it
      await importStore.commit(batch.id, batch.version);
      expect(await status(batch.id)).toBe("committed");
    });

    // An import batch that ends one recurring series (the source dropped it), written straight into the tables.
    const seriesEndBatch = async (ruleStatus: "active" | "ended") => {
      const userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
      const rule = (
        await sql<{ id: string; version: number }[]>`
          INSERT INTO commitment_recurrence_rules (user_id,title,timezone,start_date,interval_days,local_start_time,local_end_time,presence,share_to_calendar,status)
          VALUES (${userId},'Series','Australia/Sydney','2026-09-01',7,'18:00','19:00','blocking',false,${ruleStatus}) RETURNING id, version`
      )[0]!;
      await sql`INSERT INTO import_entity_keys (user_id,entity_type,import_key,entity_id) VALUES (${userId},'fixed_commitment_recurrence','series-1',${rule.id})`;
      const batch = (
        await sql<{ id: string; version: number }[]>`
          INSERT INTO import_batches (user_id,source_type,input_kind,timezone,template_version,status)
          VALUES (${userId},'csv','capacity_commitments','Australia/Sydney','1','ready') RETURNING id, version`
      )[0]!;
      await sql`INSERT INTO import_records (id,batch_id,import_key,entity_type,operation,expected_version,matched_entity_id,fields,relationships,validation_errors,warnings,removed,sort_order)
        VALUES (${crypto.randomUUID()},${batch.id},'series-1','fixed_commitment_recurrence','delete',${rule.version},${rule.id},${sql.json({})},${sql.json({})},${sql.json([])},${sql.json([])},false,0)`;
      return { batch, ruleId: rule.id };
    };

    it("counts an import that ends a series as one closure: refused past 20, applied when it fits", async () => {
      await store.put(createSeedState(fixedNow));
      await spend(20);
      const over = await seriesEndBatch("active");
      await expect(asTokenAgent(() => importStore.commit(over.batch.id, over.batch.version))).rejects.toThrow(
        /21 closures by agents in the last hour/
      );
      expect(await status(over.batch.id)).not.toBe("committed");
      expect(
        (await sql<{ status: string }[]>`SELECT status FROM commitment_recurrence_rules WHERE id=${over.ruleId}`)[0]!
          .status
      ).toBe("active");
    });

    it("lets an import ending a series through when it fits the hour, and writes the one ledger row under the batch", async () => {
      await store.put(createSeedState(fixedNow));
      await spend(19);
      const fits = await seriesEndBatch("active");
      await sql`INSERT INTO commitments (user_id,title,starts_at,ends_at,recurrence_rule_id,local_date)
        SELECT user_id,'Series',now()+interval '3 days',now()+interval '3 days 1 hour',id,current_date+3 FROM commitment_recurrence_rules WHERE id=${fits.ruleId}`;
      await asTokenAgent(() => importStore.commit(fits.batch.id, fits.batch.version));
      expect(await status(fits.batch.id)).toBe("committed");
      const rows = await sql<
        { write_id: string; evidence: { closed: number; via: string } }[]
      >`SELECT write_id, evidence FROM write_rows WHERE entity_type='commitment_recurrence_rule' AND operation='close'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.evidence).toMatchObject({ closed: 1, via: "import" });
      expect(rows[0]!.write_id).toBe(fits.batch.id);
    });

    it("counts nothing for a series that is already ended", async () => {
      await store.put(createSeedState(fixedNow));
      await spend(20);
      const ended = await seriesEndBatch("ended");
      await asTokenAgent(() => importStore.commit(ended.batch.id, ended.batch.version));
      expect(await status(ended.batch.id)).toBe("committed");
    });

    it("lets a small cancelling import through and counts it", async () => {
      await store.put(createSeedState(fixedNow));
      await seedCommitments(2);
      const batch = await commitments(
        Array.from({ length: 2 }, (_, i) => cancelRow(`l-${i}`, `Lecture ${i}`)).join("\r\n")
      );
      await asTokenAgent(() => importStore.commit(batch.id, batch.version));
      // One ledger row per cancelled commitment (the brake counts their `closed` figures), all under the batch's command id.
      const rows = await sql<
        { evidence: { closed: number; via: string; counted: boolean }; write_id: string }[]
      >`SELECT evidence, write_id FROM write_rows WHERE operation='close' AND entity_type='commitment'`;
      expect(rows.map((r) => r.evidence)).toMatchObject([
        { closed: 1, via: "import", counted: true },
        { closed: 1, via: "import", counted: true }
      ]);
      expect(new Set(rows.map((r) => r.write_id)).size).toBe(1);
      expect(rows[0]!.write_id).toBe(batch.id);
    });
  });

  describe("the save floor on closed statuses", () => {
    const areas = (csv: string) =>
      importStore.preview({
        sourceType: "csv",
        inputKind: "capacity_commitments",
        timezone: "Australia/Sydney",
        templateVersion: "1",
        records: parseImportCsv("areas", `import_key,name,description,status,sort_order\r\n${csv}`),
        source: {}
      });
    const areaStatus = async (name: string) =>
      (await sql<{ status: string }[]>`SELECT status::text AS status FROM areas WHERE name=${name}`)[0]?.status;

    it("refuses an area created closed, closed by update, or reopened by update, and the person can import it", async () => {
      await store.put(createSeedState(fixedNow));
      const born = await areas("born,Born,,archived,5");
      await expect(asAgent(() => importStore.commit(born.id, born.version))).rejects.toThrow(
        /cannot be created already archived/
      );
      expect(await areaStatus("Born")).toBeUndefined();

      const open = await areas("trip,Trip,,active,6");
      await asAgent(() => importStore.commit(open.id, open.version));
      expect(await areaStatus("Trip")).toBe("active");
      const closing = await areas("trip,Trip,,archived,6");
      expect(closing.records[0]?.operation).toBe("update");
      await expect(asAgent(() => importStore.commit(closing.id, closing.version))).rejects.toThrow(/rhen_archive/);
      expect(await areaStatus("Trip")).toBe("active");

      await importStore.commit(closing.id, closing.version);
      expect(await areaStatus("Trip")).toBe("archived");
      const reopen = await areas("trip,Trip,,active,6");
      await expect(asAgent(() => importStore.commit(reopen.id, reopen.version))).rejects.toThrow(/restore/);
      expect(await areaStatus("Trip")).toBe("archived");
    });
  });

  describe("conditions and commitments under the same floor", () => {
    const conditions = (csv: string) =>
      importStore.preview({
        sourceType: "csv",
        inputKind: "capacity_commitments",
        timezone: "Australia/Sydney",
        templateVersion: "1",
        records: parseImportCsv("conditions", `import_key,name,kind,status\r\n${csv}`),
        source: {}
      });
    const conditionStatus = async () =>
      (await sql<{ status: string }[]>`SELECT status::text AS status FROM condition_definitions WHERE id='gym'`)[0]
        ?.status;

    it("refuses a blank status cell on an archived condition, which the import would write as active", async () => {
      await store.put(createSeedState(fixedNow));
      const first = await conditions("gym,Gym,capability,active");
      await importStore.commit(first.id, first.version);
      const archive = await conditions("gym,Gym,capability,archived");
      await importStore.commit(archive.id, archive.version);
      expect(await conditionStatus()).toBe("archived");
      const blank = await conditions("gym,Gym,capability,");
      expect(blank.records[0]?.operation).toBe("update");
      await expect(asAgent(() => importStore.commit(blank.id, blank.version))).rejects.toThrow(/restore/);
      expect(await conditionStatus()).toBe("archived");
      // the person's own import of the same sheet reopens it
      await importStore.commit(blank.id, blank.version);
      expect(await conditionStatus()).toBe("active");
    });

    const cancelled = (key: string, state: string) => `${key},Talk,${starts},${ends},${state},0,0`;

    it("refuses a commitment born cancelled and a cancelled one reopened, but still lets one be cancelled", async () => {
      await store.put(createSeedState(fixedNow));
      const born = await commitments(cancelled("talk", "cancelled"));
      await expect(asAgent(() => importStore.commit(born.id, born.version))).rejects.toThrow(
        /cannot be created already cancelled/
      );
      const open = await commitments(cancelled("talk", "confirmed"));
      await importStore.commit(open.id, open.version);
      const cancel = await commitments(cancelled("talk", "cancelled"));
      await asAgent(() => importStore.commit(cancel.id, cancel.version));
      expect(
        (await sql<{ status: string }[]>`SELECT status::text AS status FROM commitments WHERE title='Talk'`)[0]?.status
      ).toBe("cancelled");
      const reopen = await commitments(cancelled("talk", "tentative"));
      await expect(asAgent(() => importStore.commit(reopen.id, reopen.version))).rejects.toThrow(/restore/);
      expect(
        (await sql<{ status: string }[]>`SELECT status::text AS status FROM commitments WHERE title='Talk'`)[0]?.status
      ).toBe("cancelled");
    });

    describe("a link record that carries a status", () => {
      const asLink = async (batchId: string) =>
        sql`UPDATE import_records SET operation='link', relationships = relationships || '{"sourceMatchDiffFields":"status"}'::jsonb WHERE batch_id=${batchId}`;
      const talkStatus = async () =>
        (await sql<{ status: string }[]>`SELECT status::text AS status FROM commitments WHERE title='Talk'`)[0]?.status;
      const asTokenAgent = <T>(fn: () => Promise<T>) =>
        runWithActor("claude", fn, undefined, undefined, ["write:import"]);

      it("is counted by the brake when it cancels a commitment", async () => {
        await store.put(createSeedState(fixedNow));
        const open = await commitments(cancelled("talk", "confirmed"));
        await importStore.commit(open.id, open.version);
        const cancel = await commitments(cancelled("talk", "cancelled"));
        await asLink(cancel.id);
        // a cancel by link counts: with the hour spent it is refused, and the row stays open
        const userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
        const writeId = crypto.randomUUID();
        await sql`INSERT INTO writes (id,user_id,command_type,actor) VALUES (${writeId},${userId},'close_entity','claude')`;
        await sql`INSERT INTO write_rows (write_id,user_id,entity_type,entity_id,operation,evidence) VALUES (${writeId},${userId},'action','seed','close',${sql.json({ closed: 20, counted: true } as never)})`;
        await expect(asTokenAgent(() => importStore.commit(cancel.id, cancel.version))).rejects.toThrow(
          /over the 20 allowed/
        );
        expect(await talkStatus()).toBe("confirmed");
        // within the budget it lands and is counted
        await sql`DELETE FROM write_rows WHERE write_id=${writeId}`;
        await asTokenAgent(() => importStore.commit(cancel.id, cancel.version));
        expect(await talkStatus()).toBe("cancelled");
        expect(
          await sql`SELECT 1 FROM write_rows WHERE operation='close' AND evidence->>'via'='import' AND (evidence->>'closed')::int=1`
        ).toHaveLength(1);
      });
    });
  });
});
