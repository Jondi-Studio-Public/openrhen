import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { proposalSummary, readStoredFacts, storedRecord } from "./agent-enforcement";
import { stableUuid } from "./persistence/postgres/command-values";
import { setupStateStoreSuite, sql, store } from "./persistence/postgres/state-store-harness";

/**
 * What a proposal's summary reads from the database: the record an update would change, in the shape the
 * summary compares it in. The wording itself is tested in agent-enforcement.test.ts.
 */
setupStateStoreSuite("openrhen_agent_enforcement");

describe("the stored record a proposal summary compares with", () => {
  it("reads a record by kind and id, so a rename shows as the one field that changed", async () => {
    await store.put(createSeedState(new Date()));
    // The portal keys a record by the id it hands back, which an agent reads from the state and sends again.
    const [first] = (await store.get())!.areas;
    const area = await storedRecord(sql, "area", first!.id);
    expect(area).toMatchObject({ id: first!.id, name: first!.name });
    expect(
      proposalSummary(
        "save_entity",
        { entityType: "area", expectedVersion: area?.version ?? null, entity: { ...area, name: "Coursework" } },
        area
      )
    ).toBe(`Update area "${first!.name}": name ${first!.name} → Coursework`);
  });

  it("reads the settings, so a timezone change names both zones", async () => {
    await store.put(createSeedState(new Date()));
    const settings = await storedRecord(sql, "settings", undefined);
    expect(typeof settings?.timezone).toBe("string");
    expect(
      proposalSummary(
        "save_entity",
        {
          entityType: "settings",
          expectedVersion: settings?.version ?? null,
          entity: { timezone: "Pacific/Auckland" }
        },
        settings
      )
    ).toBe(`Update settings: timezone ${settings?.timezone} → Pacific/Auckland`);
  });

  it("is undefined for a record that is not there and for a kind the state does not hold", async () => {
    await store.put(createSeedState(new Date()));
    expect(await storedRecord(sql, "area", "area-nowhere")).toBeUndefined();
    expect(await storedRecord(sql, "sleep_log_entry", "night-1")).toBeUndefined();
  });
});

describe("the stored facts the floor reads", () => {
  it("says whether the commitment a write changes is on the family calendar now, as the handler maps its id", async () => {
    await store.put(createSeedState(new Date()));
    const [commitment] = (await store.get())!.commitments;
    const body = { entityType: "commitment", expectedVersion: 1, entity: { id: commitment!.id } };
    const facts = () => readStoredFacts(sql, "POST", "/api/commands/entity", body);
    expect(await facts()).toEqual({ shared: false });
    const [user] = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
    const id = await stableUuid(`commitment:${user!.id}`, commitment!.id);
    await sql`UPDATE commitments SET share_to_calendar=true WHERE id=${id}`;
    expect(await facts()).toEqual({ shared: true });
    // A source split names the stored id, which no save mapping turns into another.
    expect(await readStoredFacts(sql, "POST", "/api/commands/commitment-source-split", { commitmentId: id })).toEqual({
      shared: true
    });
    // A create reads nothing; a record that is not there is not shared.
    expect(await readStoredFacts(sql, "POST", "/api/commands/entity", { ...body, expectedVersion: null })).toEqual({});
    expect(
      await readStoredFacts(sql, "POST", "/api/commands/commitment-recurrence", {
        expectedVersion: 1,
        rule: { id: "r-nowhere" }
      })
    ).toEqual({ shared: false });
  });
});
