import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { recoverySkippedCommand } from "@/features/now/recovery-commands";
import { dropDesiredWinCommand } from "@/features/disruptions/disruption-commands";
import { fixedNow, setupStateStoreSuite, store } from "./state-store-harness";

/**
 * Every `daily_plan` save rewrites the day's wins and deferrals wholesale (`deleteDailyPlanLinks` then
 * re-insert), so a panel that is not about deferrals must send the stored list back. This runs the saves the
 * recovery, boundary and disruption panels build against a day that holds a deferral and reads it back.
 */
setupStateStoreSuite("openrhen_daily_plan_deferral");

describe("daily_plan saves from other panels keep the day's deferrals", () => {
  it("keeps a non-empty deferral through the recovery, boundary and disruption saves", async () => {
    const seed = createSeedState(fixedNow);
    await store.put(seed);
    const [first, second] = (await store.get())!.actions.map((action) => action.id);
    const localDate = "2026-08-18";
    const deferredItems = [{ actionId: second!, reason: "Waiting on a reply" }];

    let state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: { localDate, desiredActionIds: [first!], deferredItems }
    });
    expect(state.dailyPlan?.deferredItems).toEqual(deferredItems);

    // Recovery panel: skip, then undo.
    state = await store.saveEntity(recoverySkippedCommand(state.dailyPlan, localDate, true));
    expect(state.dailyPlan?.recoverySkipped).toBe(true);
    expect(state.dailyPlan?.deferredItems).toEqual(deferredItems);
    state = await store.saveEntity(recoverySkippedCommand(state.dailyPlan, localDate, false));
    expect(state.dailyPlan?.deferredItems).toEqual(deferredItems);

    // Boundary panel: extend the horizon (the entity it sends, built from the stored plan).
    const plan = state.dailyPlan!;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: plan.version ?? null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: {
        localDate,
        desiredActionIds: plan.desiredActionIds,
        deferredItems: plan.deferredItems,
        horizonOverrideAt: "2026-08-18T14:00:00.000Z"
      }
    });
    expect(state.dailyPlan?.deferredItems).toEqual(deferredItems);
    expect(state.dailyPlan?.desiredActionIds).toEqual([first!]);

    // Disruption panel: drop one desired win.
    state = await store.saveEntity(dropDesiredWinCommand(first!, localDate, state.dailyPlan));
    expect(state.dailyPlan?.desiredActionIds).toEqual([]);
    expect(state.dailyPlan?.deferredItems).toEqual(deferredItems);
  });
});
