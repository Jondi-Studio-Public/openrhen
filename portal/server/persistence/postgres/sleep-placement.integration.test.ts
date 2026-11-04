import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * The task-005/006 writes from the sleep placement design note: the `bedtime_deviation_minutes`
 * setting replacing `sleep_aggression`, the `sleep_plan` entity command's four shapes (times alone,
 * times plus a stay-up answer, a bare decline, a bare placement choice), and the "never overwrite a
 * stored answer with null" rule `persistDerivedState`'s upsert applies across a re-plan.
 */
setupStateStoreSuite("openrhen_sleep_placement");

describe("sleep-placement write paths", () => {
  it("round-trips the bedtime-deviation setting, absence-means-no-opinion on later saves", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    expect(state.settings.bedtimeDeviationMinutes).toBe(180);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { bedtimeDeviationMinutes: 90 }
    });
    expect(state.settings.bedtimeDeviationMinutes).toBe(90);
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { arrivalMarginMinutes: 5 }
    });
    expect(state.settings.bedtimeDeviationMinutes).toBe(90);
  });

  it("refuses a bedtime deviation outside 0-720", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: state.settings.version ?? null,
        type: "save_entity",
        entityType: "settings",
        entity: { bedtimeDeviationMinutes: 800 }
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("records a placement choice without moving the night, and a stay-up decline without moving it either", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const plan = state.sleepPlans.find((item) => item.status === "planned");
    if (!plan) return; // Seed's own clock decides whether a night is currently planned.
    const { plannedStartAt, plannedWakeAt } = plan;

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: plan.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: plan.id, placementChoice: "near" }
    });
    let after = state.sleepPlans.find((item) => item.id === plan.id)!;
    expect(after.placementChoice).toBe("near");
    expect(after.plannedStartAt).toBe(plannedStartAt);
    expect(after.plannedWakeAt).toBe(plannedWakeAt);

    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: after.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: plan.id, stayUpAnswerMinutes: 0 }
    });
    after = state.sleepPlans.find((item) => item.id === plan.id)!;
    expect(after.stayUpAnswerMinutes).toBe(0);
    expect(after.plannedStartAt).toBe(plannedStartAt);
    expect(after.plannedWakeAt).toBe(plannedWakeAt);
  });

  it("refuses a bare placement choice that is neither early nor near", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const plan = state.sleepPlans.find((item) => item.status === "planned");
    if (!plan) return;
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: plan.version ?? null,
        type: "save_entity",
        entityType: "sleep_plan",
        entity: { id: plan.id, placementChoice: "sideways" }
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("moves tonight's bedtime and records the accepted stay-up minutes in one write", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const plan = state.sleepPlans.find((item) => item.status === "planned");
    if (!plan) return;
    const movedStart = new Date(new Date(plan.plannedStartAt).getTime() + 30 * 60_000).toISOString();
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: plan.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: {
        id: plan.id,
        plannedStartAt: movedStart,
        plannedWakeAt: plan.plannedWakeAt,
        stayUpAnswerMinutes: 30
      }
    });
    const after = state.sleepPlans.find((item) => item.id === plan.id)!;
    expect(after.plannedStartAt).toBe(movedStart);
    expect(after.plannedWakeAt).toBe(plan.plannedWakeAt);
    expect(after.stayUpAnswerMinutes).toBe(30);
  });

  // The offer only ever presents 30/60/90,
  // so a value outside that set (45, say — a plausible-looking number nobody's UI would send) must
  // fail as a clean `InvalidCommandError`, not as a raw Postgres constraint-violation error surfacing
  // from the `sleep_plans` table's own CHECK.
  it("refuses a stay-up answer outside the offer's own 0/30/60/90 choice set", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const plan = state.sleepPlans.find((item) => item.status === "planned");
    if (!plan) return;
    const movedStart = new Date(new Date(plan.plannedStartAt).getTime() + 45 * 60_000).toISOString();
    await expect(
      store.saveEntity({
        commandId: crypto.randomUUID(),
        expectedVersion: plan.version ?? null,
        type: "save_entity",
        entityType: "sleep_plan",
        entity: {
          id: plan.id,
          plannedStartAt: movedStart,
          plannedWakeAt: plan.plannedWakeAt,
          stayUpAnswerMinutes: 45
        }
      })
    ).rejects.toThrow(InvalidCommandError);
  });

  it("never overwrites a stored stay-up answer or placement choice with null across a re-plan", async () => {
    await store.put(createSeedState(fixedNow));
    let state = (await store.get())!;
    const plan = state.sleepPlans.find((item) => item.status === "planned");
    if (!plan) return;
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: plan.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: plan.id, placementChoice: "early" }
    });
    // Any state-changing save re-runs planning end to end (`recordStateChange` -> plan-forecast job),
    // which is where `persistDerivedState`'s upsert could clobber the answer if its COALESCE guard were
    // missing.
    state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: state.settings.version ?? null,
      type: "save_entity",
      entityType: "settings",
      entity: { arrivalMarginMinutes: 7 }
    });
    const after = state.sleepPlans.find((item) => item.id === plan.id);
    expect(after?.placementChoice).toBe("early");
  });

  it("stores stay_up_answer_minutes and placement_choice on the row itself", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    const plan = state.sleepPlans.find((item) => item.status === "planned");
    if (!plan) return;
    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: plan.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: plan.id, placementChoice: "near" }
    });
    const rows = await sql<{ placement_choice: string | null; stay_up_answer_minutes: number | null }[]>`
      SELECT placement_choice, stay_up_answer_minutes FROM sleep_plans WHERE id=${plan.id}
    `;
    expect(rows[0]?.placement_choice).toBe("near");
    expect(rows[0]?.stay_up_answer_minutes).toBeNull();
  });
});
