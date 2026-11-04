import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { integrationDatabaseName } from "@openrhen/database";
import { refreshPlanning, setupStateStoreSuite, sql, unplannedStore } from "./persistence/postgres/state-store-harness";
import {
  connectAgent,
  contractClock,
  contractSeedState,
  seedContractPlaces,
  type AgentCall
} from "./agent-contract-fixture";

/**
 * The lapsed-pulse cold start, end to end: an agent that comes back after days away, through `/mcp` itself with
 * the OpenClaw plugin's scopes. The 2026-11-03 agent review could not drive this on a live server (the pulse was on),
 * so this replays it on a seeded one: every ordinary call is refused with the one instruction, `rhen_reenter`
 * with no arguments reads the questions, the three facts without the owner's words are refused with the exact
 * missing pieces, a stated re-entry ends the lapse and the agent works again, a start-fresh reset is refused for an
 * agent without the owner's words, and the one undo puts the lapse back.
 */
const BASE = "openrhen_agent_reentry";
setupStateStoreSuite(BASE, { resetBetweenTests: false });

const clock = contractClock();
const HOUR = 3_600_000;
let call: AgentCall;
let previousDatabaseUrl: string | undefined;
let userId: string;

const hoursAgo = (hours: number) => new Date(clock.now.getTime() - hours * HOUR);
const openSegment = async () =>
  (
    await sql<
      { state: string; reason: string | null }[]
    >`SELECT state, reason FROM pulse_segments WHERE user_id=${userId} AND ended_at IS NULL`
  )[0];

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: clock.now });
  const url = new URL(process.env.POSTGRES_ADMIN_URL!);
  url.pathname = `/${integrationDatabaseName(process.env.TEST_DATABASE_NAME, BASE)}`;
  previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = url.toString();

  await sql.unsafe("TRUNCATE TABLE users, portal_state, jobs RESTART IDENTITY CASCADE");
  await unplannedStore.put(contractSeedState(clock));
  await seedContractPlaces(unplannedStore);
  await refreshPlanning();
  userId = (await sql<{ id: string }[]>`SELECT id FROM users LIMIT 1`)[0]!.id;
  // Six days away: the open segment is off/lapsed, last confirmed 6.4 days ago.
  const confirmedHoursAgo = 6.4 * 24;
  await sql`DELETE FROM pulse_segments WHERE user_id=${userId}`;
  await sql`INSERT INTO pulse_segments (user_id, started_at, ended_at, state, reason, confirmed_at)
    VALUES (${userId}, ${hoursAgo(confirmedHoursAgo + 1)}, ${hoursAgo(confirmedHoursAgo)}, 'on', 'confirmed', ${hoursAgo(confirmedHoursAgo)})`;
  await sql`INSERT INTO pulse_segments (user_id, started_at, state, reason, confirmed_at)
    VALUES (${userId}, ${hoursAgo(confirmedHoursAgo)}, 'off', 'lapsed', ${hoursAgo(confirmedHoursAgo)})`;
  call = await connectAgent(clock);
}, 120_000);

afterAll(() => {
  vi.useRealTimers();
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

describe("an agent back after a lapsed pulse", () => {
  it("is refused on an ordinary call with the one instruction", async () => {
    for (const tool of ["rhen_status", "rhen_catch_up"]) {
      const refused = await call(tool);
      expect(refused.isError, tool).toBe(true);
      expect(refused.text, tool).toContain("rhen_reenter");
    }
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("reads what re-entry needs from rhen_reenter with no arguments, and nothing changes", async () => {
    const read = await call("rhen_reenter");
    expect(read.isError, read.text).toBe(false);
    expect(read.text).toMatch(/location/);
    expect(read.text).toMatch(/energy/);
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("refuses the three facts without the owner's words, naming what to add", async () => {
    const refused = await call("rhen_reenter", { location: "home", energy: "medium", contexts: "none" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/basis/);
    expect(refused.text).toMatch(/evidence/);
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("refuses a start-fresh reset for an agent that has only its own say-so", async () => {
    const refused = await call("rhen_reenter", {
      location: "home",
      energy: "medium",
      contexts: "none",
      basis: "stated",
      evidence: "The owner said so in the chat.",
      "settlement-json": JSON.stringify({ startFresh: true })
    });
    expect(refused.isError, refused.text).toBe(true);
    // Reads as a sentence: no empty "Still needed:" list, and the grammar of the one problem.
    expect(refused.text).not.toContain("Still needed: .");
    expect(refused.text).toContain("startFresh is not accepted");
    expect((await openSegment())?.reason).toBe("lapsed");
  });

  it("ends the lapse with stated facts, lets the agent work again, and undoes in one call", async () => {
    const done = await call("rhen_reenter", {
      location: "home",
      energy: "medium",
      contexts: "none",
      basis: "stated",
      evidence: "The owner said so in the chat."
    });
    expect(done.isError, done.text).toBe(false);
    expect((await openSegment())?.state).toBe("on");
    const status = await call("rhen_status");
    expect(status.isError, status.text).toBe(false);

    const undone = await call("rhen_undo");
    expect(undone.isError, undone.text).toBe(false);
    expect((await openSegment())?.reason).toBe("lapsed");
    expect((await call("rhen_status")).isError).toBe(true);
  });
});
