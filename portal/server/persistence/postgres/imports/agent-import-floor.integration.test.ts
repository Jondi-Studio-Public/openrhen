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
});
