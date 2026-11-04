import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { recoverySkippedCommand } from "@/features/now/recovery-commands";
import { daytimeSeed, fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The protected recovery design note, "Persistence and contract": the three recovery settings on
 * `user_preferences` and `daily_plans.recovery_skipped`, through the `settings` and `daily_plan`
 * entity commands.
 */
setupStateStoreSuite("openrhen_protected_recovery");

const saveSettings = async (entity: Record<string, unknown>) => {
  const state = (await store.get())!;
  return store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: state.settings.version ?? null,
    type: "save_entity",
    entityType: "settings",
    entity
  });
};

/**
 * The whole-hour UTC offset that puts `now` near `hour` local time, wrapped into the [-12, +14] range the
 * `Etc/GMT` zones cover. Clamping instead would leave the local hour hours away at some times of day.
 */
function offsetPinningLocalHour(hour: number, now: Date): number {
  const offset = Math.round(hour - (now.getUTCHours() + now.getUTCMinutes() / 60));
  return offset < -12 ? offset + 24 : offset;
}

describe("protected recovery persistence", () => {
  it("is off by default, with every weekday", async () => {
    await store.put(createSeedState(fixedNow));
    const { settings } = (await store.get())!;
    expect(settings.recoveryStartTime).toBeNull();
    expect(settings.recoveryEndTime).toBeNull();
    expect(settings.recoveryWeekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("stores a window and weekdays, keeps them across an unrelated save, and clears them", async () => {
    await store.put(createSeedState(fixedNow));
    let state = await saveSettings({
      recoveryStartTime: "18:00",
      recoveryEndTime: "19:15",
      recoveryWeekdays: [5, 1, 3, 1]
    });
    expect(state.settings).toMatchObject({
      recoveryStartTime: "18:00",
      recoveryEndTime: "19:15",
      recoveryWeekdays: [1, 3, 5]
    });
    state = await saveSettings({ arrivalMarginMinutes: 5 });
    expect(state.settings).toMatchObject({ recoveryStartTime: "18:00", recoveryEndTime: "19:15" });
    state = await saveSettings({ recoveryStartTime: null, recoveryEndTime: null });
    expect(state.settings.recoveryStartTime).toBeNull();
    expect(state.settings.recoveryEndTime).toBeNull();
    expect(state.settings.recoveryWeekdays).toEqual([1, 3, 5]);
  });

  it("stores an overnight window whose end is before its start", async () => {
    await store.put(createSeedState(fixedNow));
    await saveSettings({ recoveryStartTime: "19:00", recoveryEndTime: "18:00" });
    const { settings } = (await store.get())!;
    expect(settings).toMatchObject({ recoveryStartTime: "19:00", recoveryEndTime: "18:00" });
  });

  it.each([
    ["only a start", { recoveryStartTime: "18:00" }],
    ["only an end", { recoveryEndTime: "19:00" }],
    ["equal times", { recoveryStartTime: "18:00", recoveryEndTime: "18:00" }],
    ["an unaligned time", { recoveryStartTime: "18:10", recoveryEndTime: "19:00" }],
    ["a malformed time", { recoveryStartTime: "6pm", recoveryEndTime: "19:00" }],
    ["no weekdays", { recoveryWeekdays: [] }],
    ["a weekday out of range", { recoveryWeekdays: [1, 7] }]
  ])("refuses %s", async (_name, entity) => {
    await store.put(createSeedState(fixedNow));
    await expect(saveSettings(entity)).rejects.toThrow(InvalidCommandError);
  });

  it("round-trips a skip, and a horizon extension that omits the flag keeps it", async () => {
    await store.put(daytimeSeed(fixedNow));
    const localDate = "2026-08-18";
    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: { localDate, desiredActionIds: [], deferredItems: [] }
    });
    expect(state.dailyPlan?.recoverySkipped).toBe(false);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.dailyPlan?.version ?? null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: { localDate, desiredActionIds: [], deferredItems: [], recoverySkipped: true }
    });
    expect(state.dailyPlan?.recoverySkipped).toBe(true);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.dailyPlan?.version ?? null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: {
        localDate,
        desiredActionIds: [],
        deferredItems: [],
        horizonOverrideAt: new Date(Date.now() + 60 * 60_000).toISOString()
      }
    });
    expect(state.dailyPlan?.recoverySkipped).toBe(true);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.dailyPlan?.version ?? null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: { localDate, desiredActionIds: [], deferredItems: [], recoverySkipped: false }
    });
    expect(state.dailyPlan?.recoverySkipped).toBe(false);
  });

  it("reads back an override saved for an earlier planning day, leaving the day it belongs to to the engine", async () => {
    // Just after midnight the overnight planning day is still yesterday's, so its override must reach
    // the engine whichever calendar date the row carries (`dailyHorizonEnd` decides what applies).
    await store.put(createSeedState(fixedNow));
    const horizonOverrideAt = "2026-08-19T16:00:00.000Z";
    const state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: { localDate: "2026-08-18", desiredActionIds: [], deferredItems: [], horizonOverrideAt }
    });
    expect(state.dailyPlan?.localDate).toBe("2026-08-18");
    expect(state.dailyPlan?.horizonOverrideAt).toBe(horizonOverrideAt);
  });

  it("carries a still-future override from the previous day's row when the newest row has none", async () => {
    await store.put(daytimeSeed(fixedNow));
    const save = (localDate: string, horizonOverrideAt?: string) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "daily_plan",
        entity: {
          localDate,
          desiredActionIds: [],
          deferredItems: [],
          ...(horizonOverrideAt ? { horizonOverrideAt } : {})
        }
      });
    // Yesterday's day was extended two hours ahead; today's row (desired wins saved at 00:10) has none.
    const ahead = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await save("2026-08-17", ahead);
    let state = await save("2026-08-18");
    expect(state.dailyPlan?.localDate).toBe("2026-08-18");
    expect(state.dailyPlan?.horizonOverrideAt).toBe(ahead);

    // The newest row's own override always wins over a carried one.
    const own = new Date(Date.now() + 60 * 60_000).toISOString();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.dailyPlan?.version ?? null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: { localDate: "2026-08-18", desiredActionIds: [], deferredItems: [], horizonOverrideAt: own }
    });
    expect(state.dailyPlan?.horizonOverrideAt).toBe(own);
  });

  it("does not carry an override that has already passed", async () => {
    await store.put(createSeedState(fixedNow));
    const past = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const save = (localDate: string, horizonOverrideAt?: string) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "daily_plan",
        entity: {
          localDate,
          desiredActionIds: [],
          deferredItems: [],
          ...(horizonOverrideAt ? { horizonOverrideAt } : {})
        }
      });
    await save("2026-08-17", past);
    const state = await save("2026-08-18");
    expect(state.dailyPlan?.horizonOverrideAt).toBeUndefined();
  });

  it("keeps a carried override out of today's row when the recovery is toggled, and keeps the row's own", async () => {
    await store.put(daytimeSeed(fixedNow));
    const save = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "daily_plan",
        entity: { desiredActionIds: [], deferredItems: [], ...entity }
      });
    const ownOverride = async (localDate: string) =>
      (
        await sql<
          { horizon_override_at: Date | null }[]
        >`SELECT horizon_override_at FROM daily_plans WHERE local_date = ${localDate}`
      )[0]?.horizon_override_at?.toISOString() ?? null;
    const ahead = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    await save({ localDate: "2026-08-17", horizonOverrideAt: ahead });
    let state = await save({ localDate: "2026-08-18" });
    // The read carries yesterday's override onto today's plan, but it is not today's row's own.
    expect(state.dailyPlan?.horizonOverrideAt).toBe(ahead);
    expect(await ownOverride("2026-08-18")).toBeNull();

    state = await store.saveEntity(recoverySkippedCommand(state.dailyPlan, "2026-08-18", true));
    expect(state.dailyPlan?.recoverySkipped).toBe(true);
    expect(await ownOverride("2026-08-18")).toBeNull();
    expect(await ownOverride("2026-08-17")).toBe(ahead);

    // A row's own override survives a save that omits it, and an explicit null still clears it.
    const own = new Date(Date.now() + 60 * 60_000).toISOString();
    state = await save({ localDate: "2026-08-18", horizonOverrideAt: own }, state.dailyPlan?.version ?? null);
    state = await store.saveEntity(recoverySkippedCommand(state.dailyPlan, "2026-08-18", false));
    expect(await ownOverride("2026-08-18")).toBe(own);
    await save({ localDate: "2026-08-18", horizonOverrideAt: null }, state.dailyPlan?.version ?? null);
    expect(await ownOverride("2026-08-18")).toBeNull();
  });

  it("skips an overnight window on its start day's row without touching that row's wins", async () => {
    // At 05:00 an overnight window that began last night belongs to yesterday's row, which the client
    // does not hold (the newest row is today's), so the skip is a flag-only save with no version check.
    await store.put(daytimeSeed(fixedNow));
    // The stored id, which is the one the ownership check knows.
    const actionId = (await sql<{ id: string }[]>`SELECT id FROM actions LIMIT 1`)[0]!.id;
    const save = (localDate: string, desiredActionIds: string[]) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "daily_plan",
        entity: { localDate, desiredActionIds, deferredItems: [] }
      });
    await save("2026-08-17", [actionId]);
    let state = await save("2026-08-18", []);
    const desiredOn = async (localDate: string) =>
      (
        await sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM daily_plan_desired_actions d
          JOIN daily_plans p ON p.id = d.daily_plan_id WHERE p.local_date = ${localDate}`
      )[0]!.count;

    state = await store.saveEntity(recoverySkippedCommand(state.dailyPlan, "2026-08-17", true, true));
    expect(state.dailyPlan?.localDate).toBe("2026-08-18");
    expect(state.dailyPlan?.recoverySkipped).toBe(false);
    expect(state.dailyPlan?.recoverySkippedDates).toEqual(["2026-08-17"]);
    expect(await desiredOn("2026-08-17")).toBe("1");

    state = await store.saveEntity(recoverySkippedCommand(state.dailyPlan, "2026-08-17", false, true));
    expect(state.dailyPlan?.recoverySkippedDates).toEqual([]);
    expect(await desiredOn("2026-08-17")).toBe("1");
  });

  it("refuses a flag-only recovery skip that also sends other fields", async () => {
    await store.put(daytimeSeed(fixedNow));
    const ahead = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const send = (entity: Record<string, unknown>) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "daily_plan",
        entity: { localDate: "2026-08-18", recoverySkipped: true, recoverySkippedOnly: true, ...entity }
      });
    await expect(send({ horizonOverrideAt: ahead })).rejects.toThrow(InvalidCommandError);
    await expect(send({ desiredActionIds: [] })).rejects.toThrow(InvalidCommandError);
    const rows = await sql<{ horizon_override_at: Date | null }[]>`
      SELECT horizon_override_at FROM daily_plans WHERE local_date = '2026-08-18'`;
    expect(rows.every((row) => row.horizon_override_at === null)).toBe(true);
  });

  it("holds an extension to the planning day's next wake, on the one path that writes it", async () => {
    // Pin local time to about 05:00 with an overnight end (00:30) and a 07:00 wake: the day that began
    // yesterday is live, so "+3 hours" (08:00) would run into the day that begins at 07:00.
    const now = new Date();
    const offset = offsetPinningLocalHour(5, now);
    const seed = createSeedState(now);
    seed.settings.timezone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    seed.settings.planningHorizonEnd = "00:30";
    await store.put(seed);
    await saveSettings({ preferredWakeTime: "07:00" });
    const local = new Date(now.getTime() + offset * 3_600_000);
    const wake = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 7, 0) - offset * 3_600_000
    );
    expect(wake.getTime()).toBeGreaterThan(now.getTime());
    const save = (horizonOverrideAt: Date, expectedVersion: number | null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "daily_plan",
        entity: {
          localDate: local.toISOString().slice(0, 10),
          desiredActionIds: [],
          deferredItems: [],
          horizonOverrideAt: horizonOverrideAt.toISOString()
        }
      });
    const stored = async () =>
      (
        await sql<{ horizon_override_at: Date; current_horizon_end_at: Date }[]>`
          SELECT d.horizon_override_at, p.current_horizon_end_at FROM daily_plans d, user_preferences p`
      )[0]!;

    let state = await save(new Date(now.getTime() + 3 * 3_600_000), null);
    expect(state.dailyPlan?.horizonOverrideAt).toBe(wake.toISOString());
    expect((await stored()).horizon_override_at.toISOString()).toBe(wake.toISOString());
    expect((await stored()).current_horizon_end_at.toISOString()).toBe(wake.toISOString());

    // An extension that fits is stored as asked.
    const fits = new Date(Math.min(now.getTime() + 30 * 60_000, wake.getTime() - 60_000));
    state = await save(fits, state.dailyPlan?.version ?? null);
    expect(state.dailyPlan?.horizonOverrideAt).toBe(fits.toISOString());
  });

  it("clamps to this morning's wake while a night extended past midnight is still in progress", async () => {
    // Pin local time to about 00:30 with the default 22:00 end and a 07:00 wake. An earlier extension for
    // the night that began on the previous calendar date is still ahead, so that night is still the
    // active one and its wake is this morning's, not tomorrow's.
    const now = new Date();
    const offset = offsetPinningLocalHour(0.5, now);
    const seed = createSeedState(now);
    seed.settings.timezone = offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`;
    await store.put(seed);
    await saveSettings({ preferredWakeTime: "07:00" });
    const local = new Date(now.getTime() + offset * 3_600_000);
    const day = (shift: number) => new Date(local.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
    const wake = new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 7, 0) - offset * 3_600_000
    );
    expect(wake.getTime()).toBeGreaterThan(now.getTime());
    const save = (localDate: string, horizonOverrideAt: Date, expectedVersion: number | null = null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "daily_plan",
        entity: {
          localDate,
          desiredActionIds: [],
          deferredItems: [],
          horizonOverrideAt: horizonOverrideAt.toISOString()
        }
      });
    await save(day(-1), new Date(now.getTime() + 20 * 60_000));
    const state = await save(day(0), new Date(now.getTime() + 9 * 3_600_000));
    expect(state.dailyPlan?.horizonOverrideAt).toBe(wake.toISOString());
  });

  it("leaves an evening day's extension alone when it ends before tomorrow's wake", async () => {
    await store.put(daytimeSeed(fixedNow));
    const threeHours = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: {
        localDate: "2026-08-18",
        desiredActionIds: [],
        deferredItems: [],
        horizonOverrideAt: threeHours
      }
    });
    expect(state.dailyPlan?.horizonOverrideAt).toBe(threeHours);
  });
});
