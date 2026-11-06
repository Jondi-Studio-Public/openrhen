import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, unplannedStore as store } from "./state-store-harness";
import { PLAN_FORECAST_JOB_TYPE } from "@openrhen/database";

/**
 * "I'm free": `free: true` on a commitment save writes `commitments.freed_from` and nothing else about the
 * commitment, and `free: false` takes it back. It needs no title or times, is refused before the start and after
 * the effective end, and changes nothing the family calendar shows.
 */
setupStateStoreSuite("openrhen_commitment_free");

const MINUTE = 60_000;
const iso = (offsetMinutes: number) => new Date(fixedNow.getTime() + offsetMinutes * MINUTE).toISOString();

async function create(id: string, startOffset: number, endOffset: number, extra: Record<string, unknown> = {}) {
  return store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "commitment",
    entity: {
      id,
      title: "Soccer",
      startsAt: iso(startOffset),
      endsAt: iso(endOffset),
      status: "confirmed",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      ...extra
    }
  });
}

const statement = (id: string, free: unknown, expectedVersion: number | null, extra: Record<string, unknown> = {}) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "commitment",
    entity: { id, free, ...extra }
  } as never);

interface Row {
  version: number;
  title: string;
  starts_at: Date;
  ends_at: Date;
  status: string;
  share_to_calendar: boolean;
  location: string | null;
  freed_from: Date | null;
}
const rowOf = async (id: string) =>
  (
    await sql<
      Row[]
    >`SELECT version,title,starts_at,ends_at,status,share_to_calendar,location,freed_from FROM commitments WHERE id=${id}`
  )[0]!;
const planningJobs = async () =>
  (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM jobs WHERE type=${PLAN_FORECAST_JOB_TYPE}`)[0]!.n;

describe("free on a commitment", () => {
  it("writes freed_from, bumps the version, touches nothing the calendar shows and queues a recalculation", async () => {
    await store.put(createSeedState(fixedNow));
    const id = crypto.randomUUID();
    await create(id, -120, 120, { shareToCalendar: true, location: "Pitch" });
    const before = await rowOf(id);
    expect(before.freed_from).toBeNull();
    const jobsBefore = await planningJobs();

    const asked = Date.now();
    const state = await statement(id, true, before.version);
    const after = await rowOf(id);

    expect(after.freed_from).not.toBeNull();
    expect(after.freed_from!.getTime()).toBeGreaterThanOrEqual(asked - 1000);
    expect(after.freed_from!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(after.version).toBe(before.version + 1);
    // The outbound event: title, times, place, status and the share flag are exactly as they were.
    expect({
      title: after.title,
      starts: after.starts_at.getTime(),
      ends: after.ends_at.getTime(),
      status: after.status,
      shared: after.share_to_calendar,
      location: after.location
    }).toEqual({
      title: before.title,
      starts: before.starts_at.getTime(),
      ends: before.ends_at.getTime(),
      status: before.status,
      shared: before.share_to_calendar,
      location: before.location
    });
    // A planning input: a recalculation was queued, and the state carries the fact.
    expect(await planningJobs()).toBeGreaterThan(jobsBefore);
    expect(state.commitments.find((item) => item.id === id)).toMatchObject({ freedFrom: expect.any(String) });
  });

  it("keeps the first instant when freed twice, and clears with free false", async () => {
    await store.put(createSeedState(fixedNow));
    const id = crypto.randomUUID();
    await create(id, -60, 60);
    await statement(id, true, (await rowOf(id)).version);
    const first = (await rowOf(id)).freed_from!;
    await statement(id, true, (await rowOf(id)).version);
    expect((await rowOf(id)).freed_from!.getTime()).toBe(first.getTime());

    const state = await statement(id, false, (await rowOf(id)).version);
    expect((await rowOf(id)).freed_from).toBeNull();
    expect(state.commitments.find((item) => item.id === id)?.freedFrom).toBeUndefined();
  });

  it("is refused before the commitment starts, naming cancel", async () => {
    await store.put(createSeedState(fixedNow));
    const id = crypto.randomUUID();
    await create(id, 30, 90);
    const error = await statement(id, true, (await rowOf(id)).version).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidCommandError);
    expect((error as Error).message).toContain("has not started");
    expect((error as InvalidCommandError).nextCall?.tool).toBe("rhen_cancel");
    expect((await rowOf(id)).freed_from).toBeNull();
  });

  it("is refused after the end, and for a commitment that is not confirmed", async () => {
    await store.put(createSeedState(fixedNow));
    const over = crypto.randomUUID();
    await create(over, -120, -10);
    await expect(statement(over, true, (await rowOf(over)).version)).rejects.toThrow(/already ended/);

    const maybe = crypto.randomUUID();
    await create(maybe, -60, 60, { status: "tentative" });
    await expect(statement(maybe, true, (await rowOf(maybe)).version)).rejects.toThrow(/tentative/);
  });

  it("counts tracked overtime as the effective end, so a commitment that overran can still be freed", async () => {
    await store.put(createSeedState(fixedNow));
    const id = crypto.randomUUID();
    // Scheduled to end ten minutes ago; a session against it began before the end and is still going.
    await create(id, -120, -10);
    const users = await sql<{ id: string }[]>`SELECT id FROM users ORDER BY created_at LIMIT 1`;
    await sql`INSERT INTO sessions (user_id,target_type,target_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${users[0]!.id},'fixed_commitment',${id},'running',${iso(-120)},${iso(-10)},${iso(-115)},105,0)`;
    await statement(id, true, (await rowOf(id)).version);
    expect((await rowOf(id)).freed_from).not.toBeNull();
  });

  it("is refused with another field beside it, a non-boolean, a stale version and an unknown commitment", async () => {
    await store.put(createSeedState(fixedNow));
    const id = crypto.randomUUID();
    await create(id, -60, 60);
    const { version } = await rowOf(id);
    await expect(statement(id, true, version, { title: "Other" })).rejects.toThrow(/free is a statement on its own/);
    await expect(statement(id, "yes", version)).rejects.toBeInstanceOf(InvalidCommandError);
    await expect(statement(id, true, version + 5)).rejects.toThrow();
    await expect(statement(crypto.randomUUID(), true, 1)).rejects.toThrow();
    expect((await rowOf(id)).freed_from).toBeNull();
  });

  it("is undone by an agent's write snapshot like any other save, freed_from included", async () => {
    await store.put(createSeedState(fixedNow));
    const id = crypto.randomUUID();
    await create(id, -60, 60);
    await statement(id, true, (await rowOf(id)).version);
    const freed = await rowOf(id);
    await statement(id, false, freed.version);
    expect((await rowOf(id)).freed_from).toBeNull();
  });
});
