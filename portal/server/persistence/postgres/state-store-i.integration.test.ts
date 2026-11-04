import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { readSleepLog } from "./readers/sleep-log-read";
import { pinClockToSeedZoneHour, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * State-store journeys, part 9 of 12.
 *
 * One 6,800-line file until 2026-09-10, when it was the integration gate's wall clock: about ten
 * minutes of a fourteen-minute run, so every other file finished long before it and their workers
 * idled. The tests are unchanged and still run in the order they were written; only the file they
 * live in changed. The fixture they share is `./state-store-harness`, and the base name below is
 * what gives this file its own database — no two of these files may share one, or they would
 * truncate each other in `beforeEach`.
 *
 * Split again on 2026-10-30, from four files into twelve, for the same reason: two of the four were
 * the gate's wall clock at about 130 seconds each, and vitest parallelises by file only.
 */

setupStateStoreSuite("openrhen_state_store_i");

describe("normalized PostgreSQL portal persistence (part 9)", () => {
  it("refuses a logged night that overlaps a sleep still running, and allows one that ends as it began", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const hours = (count: number) => new Date(now.getTime() - count * 60 * 60_000);
    const write = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity
      });
    const log = (from: number, to: number) =>
      write({ sleepAt: hours(from).toISOString(), wakeAt: hours(to).toISOString() });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: planned.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: planned.id,
      plannedMinutes: planned.allowedMinutes
    });
    const started = state.sleepPlans.find((item) => item.id === planned.id)!;
    // Under way since two hours ago: it has no wake yet, so it runs on from its start.
    await write({ id: started.id, sleepAt: hours(2).toISOString() }, started.version ?? null);
    const refusal = `still running (id ${started.id}), and this night overlaps it. Finish the running sleep instead`;
    await expect(log(10, 1)).rejects.toThrow(refusal);
    await expect(log(1, 0.5)).rejects.toThrow(refusal);
    state = await log(10, 2);
    const evening = state.sleepPlans.find((item) => item.manual)!;
    // Correcting that night into the running sleep is refused too.
    await expect(
      write(
        { id: evening.id, sleepAt: hours(10).toISOString(), wakeAt: hours(1).toISOString() },
        evening.version ?? null
      )
    ).rejects.toThrow(refusal);
    state = (await store.get())!;
    expect(state.sleepPlans.find((item) => item.id === evening.id)!.actualWakeAt).toBe(hours(2).toISOString());
    expect(state.sleepPlans.find((item) => item.id === started.id)!.status).toBe("sleeping");
  }, 30_000);

  it("re-asserts the last asserted location as of a recorded wake, and only forward", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    const situation = (partial: Record<string, unknown>) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "current_availability",
        entity: { currentEnergy: "medium", assertedConditions: [], currentSituation: partial }
      });
    const logSleep = (sleepAt: Date, wakeAt: Date) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { sleepAt: sleepAt.toISOString(), wakeAt: wakeAt.toISOString() }
      });
    // The current location must be a saved place.
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "condition_definition",
      entity: { id: "home", name: "Home", kind: "location", latitude: -36.1, longitude: 146.9 }
    });
    state = (await store.get())!;
    // Asserted "home" a while ago; a wake after that moves the assertion up to the wake time.
    state = await situation({ locationId: "home" });
    const assertedAt = state.currentSituation.locationSetAt!;
    await sql`UPDATE user_preferences SET current_situation = jsonb_set(current_situation, '{locationSetAt}', to_jsonb(${new Date(now.getTime() - 20 * 60 * 60_000).toISOString()}::text))`;
    const recentWake = new Date(now.getTime() - 2 * 60 * 60_000);
    state = await logSleep(new Date(now.getTime() - 10 * 60 * 60_000), recentWake);
    expect(state.currentSituation.locationId).toBe("home");
    expect(state.currentSituation.locationSetAt).toBe(recentWake.toISOString());
    expect(state.currentSituation.locationSetAt).not.toBe(assertedAt);
    // Back-dating an older sleep must not regress the newer assertion.
    state = await logSleep(new Date(now.getTime() - 40 * 60 * 60_000), new Date(now.getTime() - 32 * 60 * 60_000));
    expect(state.currentSituation.locationSetAt).toBe(recentWake.toISOString());
    // With no location asserted, a wake invents none. This night starts as the 10-hour one ended: nights may
    // touch, never overlap.
    state = await situation({ locationId: null });
    state = await logSleep(new Date(now.getTime() - 2 * 60 * 60_000), new Date(now.getTime() - 30 * 60_000));
    expect(state.currentSituation.locationId).toBeNull();
    // The same rule applies when a planned sleep is finished with "I'm awake".
    state = await situation({ locationId: "home" });
    await sql`UPDATE user_preferences SET current_situation = jsonb_set(current_situation, '{locationSetAt}', to_jsonb(${new Date(now.getTime() - 20 * 60 * 60_000).toISOString()}::text))`;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: (await store.get())!.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const sleep = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: sleep.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: sleep.id,
      plannedMinutes: sleep.allowedMinutes
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    expect(state.currentSituation.locationId).toBe("home");
    expect(new Date(state.currentSituation.locationSetAt!).getTime()).toBeGreaterThanOrEqual(now.getTime() - 60_000);
    expect(state.currentSituation.locationSetAt).toBe(state.settings.lastWokeAt);
  }, 60_000);

  // Reported: only a hand-logged night (input_version='manual') could ever be corrected. A night
  // tracked live via Start/Stop on Now — the common case — had input_version left NULL and no path to
  // fix a mistake in it at all. sleep_log_entry replaces manual_sleep_entry and covers both.
  it("corrects a tracked completed sleep, leaving the planned times as evidence of what the engine scheduled", async () => {
    const now = pinClockToSeedZoneHour();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: planned.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: planned.id,
      plannedMinutes: planned.allowedMinutes
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    const tracked = state.sleepPlans.find((item) => item.id === planned.id)!;
    expect(tracked.manual).toBeUndefined();
    const linkedSession = (
      await sql<{ id: string }[]>`SELECT id FROM sessions WHERE target_type='sleep' AND target_id=${tracked.id}`
    )[0]!;
    const correctedStart = new Date(new Date(tracked.actualStartAt!).getTime() - 30 * 60_000);
    const correctedWake = new Date(new Date(tracked.actualWakeAt!).getTime() - 15 * 60_000);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: tracked.version ?? null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { id: tracked.id, sleepAt: correctedStart.toISOString(), wakeAt: correctedWake.toISOString() }
    });
    const corrected = state.sleepPlans.find((item) => item.id === tracked.id)!;
    // Planned times are what the engine actually scheduled — untouched by a correction to what happened.
    expect(corrected.plannedStartAt).toBe(tracked.plannedStartAt);
    expect(corrected.plannedWakeAt).toBe(tracked.plannedWakeAt);
    expect(corrected.actualStartAt).toBe(correctedStart.toISOString());
    expect(corrected.actualWakeAt).toBe(correctedWake.toISOString());
    const expectedMinutes = Math.round((correctedWake.getTime() - correctedStart.getTime()) / 60000);
    expect(corrected.allowedMinutes).toBe(expectedMinutes);
    const completedEntry = state.completedToday.find(
      (item) => item.targetType === "sleep" && item.actionId === tracked.id
    );
    expect(completedEntry).toMatchObject({
      startedAt: correctedStart.toISOString(),
      endedAt: correctedWake.toISOString(),
      activeMinutes: expectedMinutes
    });
    const sessionAfter = (
      await sql<
        { started_at: Date; ended_at: Date; active_minutes: number }[]
      >`SELECT started_at,ended_at,active_minutes FROM sessions WHERE id=${linkedSession.id}`
    )[0]!;
    expect(sessionAfter.started_at.toISOString()).toBe(correctedStart.toISOString());
    expect(sessionAfter.ended_at.toISOString()).toBe(correctedWake.toISOString());
    expect(sessionAfter.active_minutes).toBe(expectedMinutes);
    const segmentAfter = (
      await sql<
        { started_at: Date; ended_at: Date }[]
      >`SELECT started_at,ended_at FROM session_segments WHERE session_id=${linkedSession.id}`
    )[0]!;
    expect(segmentAfter.started_at.toISOString()).toBe(correctedStart.toISOString());
    expect(segmentAfter.ended_at.toISOString()).toBe(correctedWake.toISOString());
    // Persisted, not just echoed back: a fresh read shows the same correction.
    const reloaded = (await store.get())!;
    const reloadedPlan = reloaded.sleepPlans.find((item) => item.id === tracked.id)!;
    expect(reloadedPlan.actualStartAt).toBe(correctedStart.toISOString());
    expect(reloadedPlan.actualWakeAt).toBe(correctedWake.toISOString());
    const reloadedCompleted = reloaded.completedToday.find((item) => item.actionId === tracked.id)!;
    expect(reloadedCompleted.startedAt).toBe(correctedStart.toISOString());
    expect(reloadedCompleted.endedAt).toBe(correctedWake.toISOString());
  }, 30_000);

  it("corrects a still-sleeping tracked row's start, but refuses a wake time sent through the log", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: planned.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: planned.id,
      plannedMinutes: planned.allowedMinutes
    });
    const sleeping = state.sleepPlans.find((item) => item.id === planned.id)!;
    expect(sleeping.status).toBe("sleeping");
    const correctedStart = new Date(new Date(sleeping.actualStartAt!).getTime() - 20 * 60_000);
    // Recording a wake is finish_activity's job — it also derives last_woke_at and re-asserts location.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleeping.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleeping.id, sleepAt: correctedStart.toISOString(), wakeAt: now.toISOString() }
      })
    ).rejects.toThrow("finishing the sleep session");
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: sleeping.version ?? null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { id: sleeping.id, sleepAt: correctedStart.toISOString() }
    });
    const corrected = state.sleepPlans.find((item) => item.id === sleeping.id)!;
    expect(corrected.status).toBe("sleeping");
    expect(corrected.actualStartAt).toBe(correctedStart.toISOString());
    const session = (
      await sql<
        { started_at: Date; ended_at: Date | null }[]
      >`SELECT started_at,ended_at FROM sessions WHERE target_type='sleep' AND target_id=${sleeping.id}`
    )[0]!;
    expect(session.started_at.toISOString()).toBe(correctedStart.toISOString());
    expect(session.ended_at).toBeNull();
    const segment = (
      await sql<
        { started_at: Date; ended_at: Date | null }[]
      >`SELECT started_at,ended_at FROM session_segments WHERE session_id=(SELECT id FROM sessions WHERE target_type='sleep' AND target_id=${sleeping.id})`
    )[0]!;
    expect(segment.started_at.toISOString()).toBe(correctedStart.toISOString());
    expect(segment.ended_at).toBeNull();
  }, 30_000);

  // a future last-woke time from Settings or setup reads as still asleep, pushing every
  // planned night off a wake that has not happened.
  it("refuses a last-woke time in the future from Settings, keeping the stored one", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { ...state.settings, lastWokeAt: new Date(now.getTime() + 24 * 60 * 60_000).toISOString() }
      })
    ).rejects.toThrow("more than 5 minutes in the future");
    expect((await store.get())!.settings.lastWokeAt).toBe(now.toISOString());
    // Inside the same five-minute grace the sleep log allows, for a clock a little ahead.
    const nearlyNow = new Date(now.getTime() + 2 * 60_000);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, lastWokeAt: nearlyNow.toISOString() }
    });
    expect(state.settings.lastWokeAt).toBe(nearlyNow.toISOString());
  }, 30_000);

  // a still-sleeping night's start corrected past its eventual wake stored a completed row
  // with actual_start_at after actual_wake_at, the corrupted shape.
  it("refuses to move a still-sleeping night's start into the future or before the last recorded wake", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const earlierWake = new Date(now.getTime() - 10 * 60 * 60_000);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: {
        id: crypto.randomUUID(),
        sleepAt: new Date(earlierWake.getTime() - 8 * 60 * 60_000).toISOString(),
        wakeAt: earlierWake.toISOString()
      }
    });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: planned.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: planned.id,
      plannedMinutes: planned.allowedMinutes
    });
    const sleeping = state.sleepPlans.find((item) => item.id === planned.id)!;
    const correct = (sleepAt: Date) =>
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleeping.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleeping.id, sleepAt: sleepAt.toISOString() }
      });
    await expect(correct(new Date(now.getTime() + 60 * 60_000))).rejects.toThrow("cannot start in the future");
    await expect(correct(new Date(earlierWake.getTime() - 60_000))).rejects.toThrow("before your last recorded wake");
    const unchanged = (await store.get())!.sleepPlans.find((item) => item.id === sleeping.id)!;
    expect(unchanged.actualStartAt).toBe(sleeping.actualStartAt);
    const allowed = new Date(earlierWake.getTime() + 60_000);
    state = await correct(allowed);
    expect(state.sleepPlans.find((item) => item.id === sleeping.id)!.actualStartAt).toBe(allowed.toISOString());
  }, 30_000);

  it("deletes a tracked completed sleep, removing its linked session and cascading its segments", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    const planned = state.sleepPlans.find((item) => item.status === "planned")!;
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: planned.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: planned.id,
      plannedMinutes: planned.allowedMinutes
    });
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "completed"
    });
    const tracked = state.sleepPlans.find((item) => item.id === planned.id)!;
    const linkedSession = (
      await sql<{ id: string }[]>`SELECT id FROM sessions WHERE target_type='sleep' AND target_id=${tracked.id}`
    )[0]!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: tracked.version ?? null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { id: tracked.id, remove: true }
    });
    expect(state.sleepPlans.find((item) => item.id === tracked.id)).toBeUndefined();
    expect(state.completedToday.some((item) => item.actionId === tracked.id)).toBe(false);
    expect(await sql`SELECT id FROM sleep_plans WHERE id=${tracked.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM sessions WHERE id=${linkedSession.id}`).toHaveLength(0);
    expect(await sql`SELECT id FROM session_segments WHERE session_id=${linkedSession.id}`).toHaveLength(0);
  }, 30_000);

  it("refuses to edit or delete a sleep log entry outside a completed or sleeping state", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { ...state.settings, assertedConditions: ["home"], lastWokeAt: now.toISOString(), setupCompleted: true }
    });
    let sleep = state.sleepPlans.find((item) => item.status === "planned")!;
    // A planned row is not evidence of anything that happened yet.
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleep.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleep.id, sleepAt: now.toISOString(), wakeAt: now.toISOString() }
      })
    ).rejects.toThrow("so this cannot be done");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleep.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleep.id, remove: true }
      })
    ).rejects.toThrow("This command needs it to be completed");
    // "Did not sleep" abandons a live night through Now's own path; the log's delete stays out of it.
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: sleep.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: sleep.id,
      plannedMinutes: sleep.allowedMinutes
    });
    sleep = state.sleepPlans.find((item) => item.id === sleep.id)!;
    expect(sleep.status).toBe("sleeping");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleep.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleep.id, remove: true }
      })
    ).rejects.toThrow("This command needs it to be completed");
    state = await store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: state.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: state.activeSession!.id,
      outcome: "did_not_start"
    });
    sleep = state.sleepPlans.find((item) => item.id === sleep.id)!;
    expect(sleep.status).toBe("cancelled");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleep.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleep.id, sleepAt: now.toISOString(), wakeAt: now.toISOString() }
      })
    ).rejects.toThrow("so this cannot be done");
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: sleep.version ?? null,
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: { id: sleep.id, remove: true }
      })
    ).rejects.toThrow("This command needs it to be completed");
  }, 30_000);

  it("throws a version conflict on a stale sleep log edit, like every other entity", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    let state = (await store.get())!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { sleepAt: new Date(now.getTime() - 8 * 60 * 60_000).toISOString(), wakeAt: now.toISOString() }
    });
    const logged = state.sleepPlans.find((item) => item.manual)!;
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: logged.version ?? null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: {
        id: logged.id,
        sleepAt: new Date(now.getTime() - 7 * 60 * 60_000).toISOString(),
        wakeAt: now.toISOString()
      }
    });
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: logged.version ?? null, // stale: the row already moved past this version
        type: "save_entity",
        entityType: "sleep_log_entry",
        entity: {
          id: logged.id,
          sleepAt: new Date(now.getTime() - 6 * 60 * 60_000).toISOString(),
          wakeAt: now.toISOString()
        }
      })
    ).rejects.toThrow("changed after you read it");
  }, 30_000);

  // readPortalState (readers/routine-read.ts) deliberately stays windowed to 1 day (or 14 for a manual entry)
  // because it is a hot path hit on every poll and every command, and it feeds the engine. The sleep
  // log's own history view needs to reach back much further without widening that shared query.
  it("reads sleep history further back than readPortalState's own window, without widening it", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const userId = await ensureUser(sql);
    // A manual entry 20 days back: inside readSleepLog's 30-day window, outside readPortalState's own
    // 14-day window for a manual row.
    const oldManualStart = new Date(now.getTime() - 20 * 24 * 60 * 60_000);
    const oldManualWake = new Date(oldManualStart.getTime() + 8 * 60 * 60_000);
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "sleep_log_entry",
      entity: { sleepAt: oldManualStart.toISOString(), wakeAt: oldManualWake.toISOString() }
    });
    // A tracked (non-manual) row 5 days back: outside readPortalState's 1-day window for a tracked
    // plan. Inserted directly since only the engine or a live Start/Stop session ever creates one.
    const oldTrackedId = crypto.randomUUID();
    const oldTrackedStart = new Date(now.getTime() - 5 * 24 * 60 * 60_000);
    const oldTrackedWake = new Date(oldTrackedStart.getTime() + 7 * 60 * 60_000);
    await sql`
      INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status,actual_start_at,actual_wake_at)
      VALUES (${oldTrackedId},${userId},${oldTrackedStart},${oldTrackedWake},480,420,'Old tracked night.','completed',${oldTrackedStart},${oldTrackedWake})
    `;
    const portalState = (await store.get())!;
    expect(portalState.sleepPlans.some((item) => item.id === oldTrackedId)).toBe(false);
    expect(portalState.sleepPlans.some((item) => item.actualStartAt === oldManualStart.toISOString())).toBe(false);
    const wide = await readSleepLog(sql, userId, { sinceDays: 30 });
    const trackedInWide = wide.find((item) => item.id === oldTrackedId);
    expect(trackedInWide).toBeDefined();
    expect(trackedInWide?.manual).toBeUndefined();
    const manualInWide = wide.find((item) => item.actualStartAt === oldManualStart.toISOString());
    expect(manualInWide?.manual).toBe(true);
    const narrow = await readSleepLog(sql, userId, { sinceDays: 3 });
    expect(narrow.some((item) => item.id === oldTrackedId)).toBe(false);
    expect(narrow.some((item) => item.actualStartAt === oldManualStart.toISOString())).toBe(false);
  }, 30_000);

  // The engine keeps a week of planned nights ahead; the log is history plus at most tonight's plan.
  it("leaves planned nights beyond tonight and cancelled plans out of the sleep log", async () => {
    const now = new Date();
    await store.put(createSeedState(now));
    const userId = await ensureUser(sql);
    const night = async (startOffsetHours: number, status: string) => {
      const id = crypto.randomUUID();
      const start = new Date(now.getTime() + startOffsetHours * 60 * 60_000);
      const wake = new Date(start.getTime() + 8 * 60 * 60_000);
      await sql`
        INSERT INTO sleep_plans (id,user_id,planned_start_at,planned_wake_at,desired_minutes,allowed_minutes,explanation,status)
        VALUES (${id},${userId},${start},${wake},480,480,'Test night.',${status})
      `;
      return id;
    };
    const tonight = await night(6, "planned");
    const inThreeDays = await night(72, "planned");
    const cancelled = await night(-30, "cancelled");
    const ids = (await readSleepLog(sql, userId, { sinceDays: 30 })).map((item) => item.id);
    expect(ids).toContain(tonight);
    expect(ids).not.toContain(inThreeDays);
    expect(ids).not.toContain(cancelled);
  }, 30_000);
});
