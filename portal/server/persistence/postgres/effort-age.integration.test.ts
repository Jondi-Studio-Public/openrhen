import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { ensureUser } from "./ensure-user";
import { applyDeliverableStepOutcome } from "./deliverable-session-rollover";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * Effort age: `actions.remaining_set_at` says when the remaining time on an
 * action was last set or confirmed. It starts at the row's creation, moves when something sets the figure (a save
 * that changes it or says it again, a session finish that states it, a deliverable step's time being credited or
 * resaved) and stays put when a save only carries the stored figure along while changing something else.
 * (A cadence reset is checked beside the cadence writer, in `cadence-completion.integration.test.ts`.)
 */
setupStateStoreSuite("openrhen_effort_age");

const DAY = 24 * 60 * 60_000;

const actionCommand = (action: Record<string, unknown>, expectedVersion: number | null, rest = {}) =>
  ({ expectedVersion, action: { contexts: [], dependencyIds: [], ...action }, ...rest }) as never;

async function setAt(id: string): Promise<Date> {
  const rows = await sql<{ remaining_set_at: Date }[]>`SELECT remaining_set_at FROM actions WHERE id=${id}`;
  return rows[0]!.remaining_set_at;
}

/** Everything was last confirmed a month ago, so a later move is unmistakable. */
async function backdate(): Promise<Date> {
  const month = new Date(Date.now() - 30 * DAY);
  await sql`UPDATE actions SET remaining_set_at=${month}`;
  return month;
}

describe("a plain action's remaining_set_at", () => {
  it("is the creation time for a new action, and is on the wire as remainingSetAt", async () => {
    await store.put(createSeedState(fixedNow));
    const state = (await store.get())!;
    expect(state.actions.length).toBeGreaterThan(0);
    for (const action of state.actions) {
      expect(Math.abs(Date.parse(action.remainingSetAt!) - Date.now())).toBeLessThan(10 * 60_000);
      expect((await setAt(action.id)).toISOString()).toBe(action.remainingSetAt);
    }
  });

  it("moves when a save changes the remaining time or says it again, and not when it only restates it", async () => {
    await store.put(createSeedState(fixedNow));
    const month = await backdate();
    let action = (await store.get())!.actions[0]!;
    expect(action.remainingSetAt).toBe(month.toISOString());

    // An edit to something else restates the stored figure: the estimate keeps its age.
    let state = await store.saveAction(actionCommand({ ...action, title: "Renamed" }, action.version!));
    action = state.actions.find((item) => item.id === action.id)!;
    expect(action.title).toBe("Renamed");
    expect((await setAt(action.id)).toISOString()).toBe(month.toISOString());
    expect(action.remainingSetAt).toBe(month.toISOString());

    // The same save with the figure marked as said now ("still about that long") dates it afresh.
    const before = Date.now();
    state = await store.saveAction(actionCommand(action, action.version!, { remainingAsserted: true }));
    action = state.actions.find((item) => item.id === action.id)!;
    expect(Date.parse(action.remainingSetAt!)).toBeGreaterThanOrEqual(before - 1000);

    // A different figure is said now too.
    const later = await backdate();
    state = await store.saveAction(
      actionCommand({ ...action, remainingMinutes: action.remainingMinutes + 15 }, action.version!)
    );
    action = state.actions.find((item) => item.id === action.id)!;
    expect(Date.parse(action.remainingSetAt!)).toBeGreaterThanOrEqual(before - 1000);
    // And only that action's: the others keep the age they had.
    for (const other of state.actions.filter((item) => item.id !== action.id))
      expect(other.remainingSetAt).toBe(later.toISOString());
  });

  it("is ignored on the wire: a save cannot send its own date", async () => {
    await store.put(createSeedState(fixedNow));
    const month = await backdate();
    const action = (await store.get())!.actions[0]!;
    await store.saveAction(
      actionCommand({ ...action, title: "Renamed", remainingSetAt: new Date().toISOString() }, action.version!)
    );
    expect((await setAt(action.id)).toISOString()).toBe(month.toISOString());
  });

  it("survives a whole-state put that leaves it out, unless that put changes the remaining time", async () => {
    await store.put(createSeedState(fixedNow));
    const month = await backdate();
    const [changed, ...rest] = (await store.get())!.actions;
    expect(rest.length).toBeGreaterThan(0);
    // An older client or a fixture sends no dates; one action comes back with a different figure.
    const document = (await store.get())!;
    document.actions = document.actions.map(({ remainingSetAt: _dropped, ...action }) =>
      action.id === changed!.id ? { ...action, remainingMinutes: action.remainingMinutes + 15 } : action
    );
    const before = Date.now();
    await store.put(document);
    expect((await setAt(changed!.id)).getTime()).toBeGreaterThanOrEqual(before - 1000);
    for (const action of rest) expect((await setAt(action.id)).toISOString()).toBe(month.toISOString());
  });

  it("is a new action's own creation time", async () => {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    await store.saveAction(
      actionCommand(
        {
          id,
          projectId: project.id,
          title: "Fresh",
          status: "planned",
          optimisticMinutes: 5,
          expectedMinutes: 10,
          pessimisticMinutes: 15,
          remainingMinutes: 10,
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
    const created = (await store.get())!.actions.find((item) => item.title === "Fresh")!;
    expect(Math.abs(Date.parse(created.remainingSetAt!) - Date.now())).toBeLessThan(10 * 60_000);
  });
});

describe("a session finish", () => {
  async function started(plannedMinutes = 15) {
    await store.put(createSeedState(fixedNow));
    const month = await backdate();
    const action = (await store.get())!.actions[0]!;
    const state = await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      type: "start",
      actionId: action.id,
      plannedMinutes
    });
    return { month, action, session: state.activeSession! };
  }

  it("moves it when the finish states the time left, and when it completes the action", async () => {
    const progress = await started();
    await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: progress.session.version ?? null,
      type: "finish",
      sessionId: progress.session.id,
      outcome: "progress",
      remainingMinutes: 20
    });
    expect(Date.now() - (await setAt(progress.action.id)).getTime()).toBeLessThan(60_000);

    const done = await started();
    await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: done.session.version ?? null,
      type: "finish",
      sessionId: done.session.id,
      outcome: "completed"
    });
    expect(Date.now() - (await setAt(done.action.id)).getTime()).toBeLessThan(60_000);
  });

  it("leaves it alone when the finish is unsure, or the session is blocked or never started", async () => {
    const unsure = await started();
    await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: unsure.session.version ?? null,
      type: "finish",
      sessionId: unsure.session.id,
      outcome: "unsure"
    });
    expect((await setAt(unsure.action.id)).toISOString()).toBe(unsure.month.toISOString());

    const idle = await started();
    await store.runSessionCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: idle.session.version ?? null,
      type: "did_not_start",
      sessionId: idle.session.id
    });
    expect((await setAt(idle.action.id)).toISOString()).toBe(idle.month.toISOString());
  });
});

describe("a deliverable step's remaining_set_at", () => {
  const step = (id: string, title: string) => ({
    id,
    title,
    status: "planned",
    optimisticMinutes: 20,
    expectedMinutes: 30,
    pessimisticMinutes: 45,
    remainingMinutes: 30,
    energy: "low",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60
  });

  async function savedDeliverable() {
    await store.put(createSeedState(fixedNow));
    const project = (await store.get())!.projects[0]!;
    const id = crypto.randomUUID();
    const state = await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        id,
        projectId: project.id,
        title: "Assessment 2",
        status: "in_progress",
        uncertainty: "some",
        importance: 5,
        consequence: 5,
        contractVersion: 1,
        planVersion: 1,
        contractApprovedAt: fixedNow.toISOString(),
        planApprovedAt: fixedNow.toISOString(),
        steps: [step("step-diagram", "Build the diagram"), step("step-explain", "Write the explanation")],
        criteria: [{ key: "c", title: "Connectivity", required: true, stepIds: ["step-diagram", "step-explain"] }]
      }
    });
    return state.deliverables.find((item) => item.id === id)!;
  }

  const byTitle = async (title: string) =>
    (await sql<{ id: string }[]>`SELECT id FROM actions WHERE title=${title}`)[0]!.id;

  it("moves with a resave only for the step whose remaining time changed", async () => {
    const deliverable = await savedDeliverable();
    const month = await backdate();
    const diagram = await byTitle("Build the diagram");
    const explain = await byTitle("Write the explanation");

    await store.saveEntity({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "save_entity",
      entityType: "deliverable",
      entity: {
        ...deliverable,
        steps: deliverable.steps.map((item) =>
          item.title === "Build the diagram" ? { ...item, remainingMinutes: 10 } : item
        )
      }
    });
    expect(Date.now() - (await setAt(diagram)).getTime()).toBeLessThan(60_000);
    expect((await setAt(explain)).toISOString()).toBe(month.toISOString());
  });

  it("moves when a session credits time spent on the step, and not when none was spent", async () => {
    const deliverable = await savedDeliverable();
    const month = await backdate();
    const diagram = await byTitle("Build the diagram");
    const explain = await byTitle("Write the explanation");
    const userId = await ensureUser(sql);
    const sessionId = crypto.randomUUID();
    const started = new Date(Date.now() - 40 * 60_000);
    await sql`
      INSERT INTO sessions (id,user_id,target_type,target_id,target_title,target_step_id,status,planned_started_at,planned_end_at,started_at,planned_minutes,remaining_before_minutes)
      VALUES (${sessionId},${userId},'deliverable',${deliverable.id},'Assessment 2',${diagram},'running',${started},${new Date(started.getTime() + 60 * 60_000)},${started},60,60)
    `;
    // Twenty minutes on the diagram; the explanation was opened and left again within seconds, which credits none.
    await sql`INSERT INTO session_segments (session_id,started_at,ended_at,step_id) VALUES (${sessionId},${started},${new Date(started.getTime() + 20 * 60_000)},${diagram}),(${sessionId},${started},${new Date(started.getTime() + 10_000)},${explain})`;
    await sql.begin(async (tx) => {
      await applyDeliverableStepOutcome(
        tx as unknown as typeof sql,
        sessionId,
        deliverable.id,
        diagram,
        "stopped",
        new Date()
      );
    });
    const remaining = await sql<
      { remaining_minutes: number }[]
    >`SELECT remaining_minutes FROM actions WHERE id=${diagram}`;
    expect(remaining[0]!.remaining_minutes).toBe(10);
    expect(Date.now() - (await setAt(diagram)).getTime()).toBeLessThan(60_000);
    expect((await setAt(explain)).toISOString()).toBe(month.toISOString());
  });
});
