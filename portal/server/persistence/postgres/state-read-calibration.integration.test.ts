import { describe, expect, it } from "vitest";
import { ensureUser } from "./ensure-user";
import { readPortalState } from "./state-read";
import { replaceState } from "./state-replace";
import { daytimeSeed, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * (logic design §5 "Learned calibration"): `readPortalState` derives `estimateCalibration` from
 * finished one-off actions that have ended sessions, and `settings.estimateCalibrationEnabled`
 * round-trips through a settings save.
 */

setupStateStoreSuite("openrhen_calibration");

describe("readPortalState: estimateCalibration", () => {
  it("derives a factor above 1 from five finished actions that ran longer than estimated", async () => {
    const now = new Date();
    const userId = await ensureUser(sql);
    await replaceState(sql, userId, daytimeSeed(now));
    const seeded = (await readPortalState(sql))!;
    expect(seeded.estimateCalibration).toEqual({ overall: null, areas: [] });
    const projectId = seeded.actions[0]!.projectId;

    for (let index = 0; index < 5; index += 1) {
      const actionId = crypto.randomUUID();
      const completedAt = new Date(now.getTime() - (10 - index) * 60 * 60_000);
      await sql`
        INSERT INTO actions (id, project_id, title, status, optimistic_minutes, expected_minutes, pessimistic_minutes, remaining_minutes, energy, minimum_session_minutes, maximum_session_minutes, splittable, setup_minutes, importance, consequence, completed_at)
        VALUES (${actionId}, ${projectId}, ${`Finished ${index}`}, 'done', 40, 60, 90, 0, 'medium', 15, 60, true, 0, 3, 3, ${completedAt})
      `;
      await sql`
        INSERT INTO sessions (id, user_id, action_id, status, planned_started_at, planned_end_at, started_at, ended_at, planned_minutes, active_minutes, remaining_before_minutes, remaining_after_minutes)
        VALUES (${crypto.randomUUID()}, ${userId}, ${actionId}, 'completed', ${completedAt}, ${completedAt}, ${completedAt}, ${completedAt}, 60, 90, 60, 0)
      `;
    }

    const state = (await readPortalState(sql))!;
    expect(state.estimateCalibration.overall).not.toBeNull();
    expect(state.estimateCalibration.overall!.samples).toBe(5);
    expect(state.estimateCalibration.overall!.factor).toBeGreaterThan(1);
    expect(state.estimateCalibration.areas).toHaveLength(1);
    expect(state.estimateCalibration.areas[0]!.samples).toBe(5);
  }, 30_000);

  it("round-trips estimateCalibrationEnabled and leaves it alone when a save omits it", async () => {
    await store.put(daytimeSeed(new Date()));
    let state = (await store.get())!;
    expect(state.settings.estimateCalibrationEnabled).toBe(true);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { estimateCalibrationEnabled: false }
    });
    expect(state.settings.estimateCalibrationEnabled).toBe(false);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { estimateBucketsMinutes: [10, 20, 40] }
    });
    expect(state.settings.estimateCalibrationEnabled).toBe(false);
    expect((await readPortalState(sql))!.settings.estimateCalibrationEnabled).toBe(false);
  }, 30_000);
});
