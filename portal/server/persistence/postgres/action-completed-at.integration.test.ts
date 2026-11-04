import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { setupStateStoreSuite, sql, fixedNow, unplannedStore as store } from "./state-store-harness";

/** A done action saved with when it was finished keeps that time ("paid the bill Monday"), not the save's. */
setupStateStoreSuite("openrhen_action_completed_at");

const actionCommand = (action: Record<string, unknown>, expectedVersion: number | null) => ({
  expectedVersion,
  action: {
    contexts: [],
    dependencyIds: [],
    ...action
  } as never
});

async function completedAt(id: string): Promise<Date | null> {
  const rows = await sql<{ completed_at: Date | null }[]>`SELECT completed_at FROM actions WHERE id=${id}`;
  return rows[0]?.completed_at ?? null;
}

describe("an action's completion time", () => {
  it("is stored when given on a done action, kept when absent, and ignored on one that is not done", async () => {
    await store.put(createSeedState(fixedNow));
    const action = (await store.get())!.actions[0]!;
    const monday = "2026-08-31T09:00:00+10:00";

    let state = await store.saveAction(
      actionCommand({ ...action, status: "done", completedAt: monday }, action.version!)
    );
    expect((await completedAt(action.id))?.toISOString()).toBe(new Date(monday).toISOString());

    const done = state.actions.find((item) => item.id === action.id)!;
    state = await store.saveAction(
      actionCommand({ ...done, completedAt: undefined, title: "Paid the bill" }, done.version!)
    );
    expect((await completedAt(action.id))?.toISOString()).toBe(new Date(monday).toISOString());

    const renamed = state.actions.find((item) => item.id === action.id)!;
    await store.saveAction(
      actionCommand({ ...renamed, status: "planned", completedAt: "2026-09-01T09:00:00+10:00" }, renamed.version!)
    );
    expect((await completedAt(action.id))?.toISOString()).toBe(new Date(monday).toISOString());
  });

  it("is stored on a new done action", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const monday = "2026-08-31T09:00:00+10:00";
    await store.saveAction(
      actionCommand(
        {
          id,
          projectId: project.id,
          title: "Paid the bill",
          status: "done",
          completedAt: monday,
          optimisticMinutes: 5,
          expectedMinutes: 10,
          pessimisticMinutes: 15,
          remainingMinutes: 0,
          energy: "low",
          minimumSessionMinutes: 5,
          maximumSessionMinutes: 15,
          splittable: false,
          setupMinutes: 0,
          importance: 3,
          consequence: 3
        },
        null
      )
    );
    expect((await completedAt(id))?.toISOString()).toBe(new Date(monday).toISOString());
  });
});
