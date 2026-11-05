import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDatabaseName } from "@openrhen/database";
import { createSeedState } from "@/state/portal-state";
import { refreshPlanning, setupStateStoreSuite, sql, unplannedStore } from "./persistence/postgres/state-store-harness";
import { FIXTURE_ZONE, connectAgent, contractClock, type AgentCall } from "./agent-contract-fixture";

/**
 * Mark's sentence, over the MCP tools: "build the hive boxes with Pete, in the garage". The step needs the
 * garage and Pete physically, and Pete exists only in the owner's notes. An agent that follows the tool text gets a
 * refusal that names the exact next call, makes Pete a name-only contact from the notes, saves the step, sees it wait,
 * and only on the owner's own words that Pete is here does the step lead, until the owner's local midnight. Names are
 * invented; the clock is faked so the midnight is the same on every run.
 */
const BASE = "openrhen_person_requirement";
setupStateStoreSuite(BASE, { resetBetweenTests: false });

const clock = contractClock();
let call: AgentCall;
let previousDatabaseUrl: string | undefined;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock.at(1, "08:00") });
  const url = new URL(process.env.POSTGRES_ADMIN_URL!);
  url.pathname = `/${integrationDatabaseName(process.env.TEST_DATABASE_NAME, BASE)}`;
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();
  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  const base = createSeedState(clock.at(1, "08:00"));
  await unplannedStore.put({
    ...base,
    settings: { ...base.settings, timezone: FIXTURE_ZONE },
    areas: [{ id: "area-home", name: "Home", status: "active", sortOrder: 0 }],
    outcomes: [
      {
        id: "outcome-bees",
        areaId: "area-home",
        title: "Keep bees",
        definitionOfDone: "Two hives up",
        value: 3,
        status: "active"
      }
    ],
    projects: [
      {
        id: "project-hives",
        title: "Hives",
        area: "Home",
        outcomeId: "outcome-bees",
        status: "active",
        uncertainty: "known",
        value: 3,
        consequence: 3
      }
    ],
    actions: []
  });
  for (const [id, name, latitude, longitude] of [
    ["garage", "Garage", -27.47, 153.02],
    ["street", "Street", -27.48, 153.03]
  ] as const)
    await unplannedStore.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id, name, kind: "location", latitude, longitude }
    });
  const state = await unplannedStore.get();
  await unplannedStore.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: state?.settings.version ?? null,
    type: "save_entity",
    entityType: "current_availability",
    entity: { currentEnergy: "medium", assertedConditions: [], currentSituation: { locationId: "garage" } }
  });
  await refreshPlanning();
  call = await connectAgent(clock);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

interface Status {
  directive: { title: string } | null;
}
async function directive(): Promise<string | null> {
  await refreshPlanning();
  const outcome = await call("rhen_status");
  expect(outcome.isError, outcome.text.slice(0, 500)).toBe(false);
  return (outcome.json as Status).directive?.title ?? null;
}

interface Row {
  id: string;
  version: number;
  title: string;
  requirementPathways: { contextIds: string[] }[];
}
/** The stored step, as the agent reads it back (its id is the portal's, not the slug it was created with). */
async function hive(): Promise<Row> {
  const listed = await call("rhen_list", { entity: "actions", fields: "id,version,title,requirementPathways" });
  expect(listed.isError, listed.text).toBe(false);
  const row = (listed.json as Row[]).find((item) => item.title === "Build hive boxes");
  expect(row).toBeDefined();
  return row!;
}
const routes = (row: Row) => row.requirementPathways.map((route) => route.contextIds);

const HIVE = {
  entityType: "action",
  id: "hive-boxes",
  create: true,
  fields: {
    projectId: "project-hives",
    title: "Build hive boxes",
    status: "planned",
    optimisticMinutes: 30,
    expectedMinutes: 60,
    pessimisticMinutes: 90,
    remainingMinutes: 60,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    requires: ["garage", "pete@with"]
  },
  basis: "stated",
  evidence: "Build the hive boxes with Pete, in the garage."
};

describe("Mark's sentence over the MCP tools", () => {
  it("refuses a person who is only in the notes, naming the exact next call", async () => {
    const refused = await call("rhen_save", HIVE);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('"pete"');
    expect(refused.text).toContain("from notes");
    expect(refused.text).toContain("condition_definition");
    expect(refused.text).toContain("Nothing was saved");
    const stored = await call("rhen_list", { entity: "actions" });
    expect(JSON.stringify(stored.json)).not.toContain("hive-boxes");
  });

  it("refuses a bare person with both forms named, and a tag on a place", async () => {
    await call("rhen_save", {
      entityType: "condition_definition",
      id: "pete",
      create: true,
      fields: { name: "Pete", kind: "contact" },
      basis: "stated",
      evidence: "Pete is mentioned in the notes as helping with the hives."
    }).then((made) => expect(made.isError, made.text).toBe(false));
    const bare = await call("rhen_save", { ...HIVE, fields: { ...HIVE.fields, requires: ["garage", "pete"] } });
    expect(bare.isError).toBe(true);
    expect(bare.text).toContain("pete is a person");
    expect(bare.text).toContain("pete@with");
    expect(bare.text).toContain("pete@remote");
    const tagged = await call("rhen_save", { ...HIVE, fields: { ...HIVE.fields, requires: ["garage@remote"] } });
    expect(tagged.isError).toBe(true);
    expect(tagged.text).toContain("not a person");
    const remote = await call("rhen_save", { ...HIVE, fields: { ...HIVE.fields, requires: ["pete@remote"] } });
    expect(remote.isError).toBe(true);
    expect(remote.text).toContain("no way to reach");
  });

  it("saves the step once Pete exists, and the step waits", async () => {
    const saved = await call("rhen_save", HIVE);
    expect(saved.isError, saved.text).toBe(false);
    expect(routes(await hive())).toEqual([["garage", "pete@with"]]);
    expect(await directive()).not.toBe("Build hive boxes");
  });

  it("does not let an agent say Pete is here without the owner's words", async () => {
    const guess = await call("rhen_save", {
      entityType: "current_availability",
      fields: { currentEnergy: "medium", currentSituation: { presence: { pete: "here" } } }
    });
    expect(guess.isError).toBe(true);
    expect(guess.text).toContain("owner's to say");
    expect(guess.text).toContain("basis stated");
    expect(await directive()).not.toBe("Build hive boxes");
  });

  it("makes the step lead on the owner's words, until their local midnight", async () => {
    const said = await call("rhen_save", {
      entityType: "current_availability",
      fields: { currentEnergy: "medium", currentSituation: { presence: { pete: "here" } } },
      basis: "stated",
      evidence: "Pete's here today."
    });
    expect(said.isError, said.text).toBe(false);
    expect(await directive()).toBe("Build hive boxes");

    // Still true after walking off and back: it is not a momentary override.
    await call("rhen_save", {
      entityType: "current_availability",
      fields: { currentEnergy: "medium", currentSituation: { locationId: "street" } }
    }).then((moved) => expect(moved.isError, moved.text).toBe(false));
    await call("rhen_save", {
      entityType: "current_availability",
      fields: { currentEnergy: "medium", currentSituation: { locationId: "garage" } }
    });
    expect(await directive()).toBe("Build hive boxes");

    // Brisbane has no daylight saving: local midnight after Thursday 08:00 is Friday 00:00 local.
    vi.setSystemTime(clock.at(2, "00:00").getTime() - 60_000);
    expect(await directive()).toBe("Build hive boxes");
    vi.setSystemTime(clock.at(2, "00:00").getTime() + 60_000);
    await call("rhen_save", {
      entityType: "current_availability",
      fields: { currentEnergy: "medium", currentSituation: { locationId: "garage" } }
    });
    expect(await directive()).not.toBe("Build hive boxes");
  });

  it("refuses to archive Pete while the step needs him", async () => {
    const list = await call("rhen_list", { entity: "condition-definitions", fields: "id,version" });
    const pete = (list.json as { id: string; version: number }[]).find((item) => item.id === "pete")!;
    const archived = await call("rhen_archive", {
      type: "condition_definition",
      id: "pete",
      do: "close",
      "expected-version": String(pete.version),
      reason: "Pete moved away.",
      basis: "stated",
      evidence: "Pete moved away."
    });
    expect(archived.isError, archived.text).toBe(true);
    expect(archived.text).toContain("Build hive boxes");
    expect(archived.text).toContain("Nothing was archived");
  });

  it("refuses to flatten a step that offers either of two routes, and clears with an empty list", async () => {
    const before = await hive();
    const either = await call("rhen_save", {
      entityType: "action",
      id: before.id,
      "expected-version": before.version,
      fields: { requirementPathways: [["garage"], ["street"]] },
      basis: "stated",
      evidence: "Either place will do."
    });
    expect(either.isError, either.text).toBe(false);
    const two = await hive();
    expect(routes(two)).toEqual([["garage"], ["street"]]);

    const flatten = await call("rhen_save", {
      entityType: "action",
      id: two.id,
      "expected-version": two.version,
      fields: { requires: ["garage"] },
      basis: "stated",
      evidence: "It needs the garage."
    });
    expect(flatten.isError).toBe(true);
    expect(flatten.text).toContain("2 alternative routes");
    expect(flatten.text).toContain("Nothing was saved");
    expect(routes(await hive())).toEqual([["garage"], ["street"]]);

    const cleared = await call("rhen_save", {
      entityType: "action",
      id: two.id,
      "expected-version": two.version,
      fields: { requirementPathways: [] },
      basis: "stated",
      evidence: "It needs nothing."
    });
    expect(cleared.isError, cleared.text).toBe(false);
    const empty = await hive();
    expect(routes(empty)).toEqual([]);
    const again = await call("rhen_save", {
      entityType: "action",
      id: empty.id,
      "expected-version": empty.version,
      fields: { requires: ["garage", "pete@with"] },
      basis: "stated",
      evidence: "The garage and Pete."
    });
    expect(again.isError, again.text).toBe(false);
    const set = await hive();
    expect(routes(set)).toEqual([["garage", "pete@with"]]);
    const none = await call("rhen_save", {
      entityType: "action",
      id: set.id,
      "expected-version": set.version,
      fields: { requires: [] },
      basis: "stated",
      evidence: "Neither is needed after all."
    });
    expect(none.isError, none.text).toBe(false);
    expect(routes(await hive())).toEqual([]);
  });
});
