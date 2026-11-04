import { describe, expect, it } from "vitest";
import { daytimeSeed, fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * A deliverable step is an action. Starting or switching to one that was archived or cancelled must not put it back to
 * `doing`: that would reopen a closed row without the restore rules. The refusal names the exact restore call.
 */
setupStateStoreSuite("openrhen_activity_closed_step");

const step = (key: string, title: string) => ({
  id: key,
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

async function setup() {
  const now = new Date();
  await store.put(daytimeSeed(now));
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
      steps: [step("step-a", "Build the diagram"), step("step-b", "Write the explanation")],
      criteria: [{ key: "c", title: "Connectivity", required: true, stepIds: ["step-a", "step-b"] }]
    }
  } as never);
  const deliverable = state.deliverables.find((item) => item.id === id)!;
  const directive = state.planning?.result?.currentDirective;
  if (directive?.kind !== "deliverable") throw new Error("expected a deliverable directive");
  return { state, deliverable, directive, id };
}

const statusOf = async (stepId: string) =>
  (await sql<{ status: string }[]>`SELECT status::text AS status FROM actions WHERE id=${stepId}`)[0]!.status;

describe.each(["archived", "cancelled"])("a %s deliverable step", (closed) => {
  it("is refused by switch, and stays closed", async () => {
    const { state, deliverable, directive, id } = await setup();
    const [a, b] = deliverable.steps;
    const start = (stepId?: string) =>
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: deliverable.version ?? null,
        type: "start_activity",
        targetType: "deliverable",
        targetId: id,
        plannedMinutes: directive.recommendedMinutes,
        ...(stepId ? { stepId } : {})
      } as never);
    // The state schema does not yet list an archived step, so a plan built over one fails before this guard is reached:
    // an archived step is closed after the session starts, a cancelled one is also tried at start.
    const started = await start(a!.id);
    await sql`UPDATE actions SET status=${closed}::action_status WHERE id=${b!.id}`;
    await expect(
      store.runActivityCommand({
        commandId: crypto.randomUUID(),
        expectedVersion: started.activeSession?.version ?? null,
        type: "switch_deliverable_step",
        sessionId: started.activeSession!.id,
        stepId: b!.id
      } as never)
    ).rejects.toMatchObject({
      nextCall: { arguments: { type: "action", do: "restore" } }
    });
    expect(await statusOf(b!.id)).toBe(closed);
    void state;
  });
});

it("is refused at start when the named step is cancelled", async () => {
  const { deliverable, directive, id } = await setup();
  const [, b] = deliverable.steps;
  await sql`UPDATE actions SET status='cancelled' WHERE id=${b!.id}`;
  await expect(
    store.runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: deliverable.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: id,
      plannedMinutes: directive.recommendedMinutes,
      stepId: b!.id
    } as never)
  ).rejects.toMatchObject({ nextCall: { arguments: { type: "action", do: "restore" } } });
  expect(await statusOf(b!.id)).toBe("cancelled");
});

it("does not put a step archived mid-session back to planned or done when the session finishes", async () => {
  const { deliverable, directive, id } = await setup();
  const [a] = deliverable.steps;
  const started = await store.runActivityCommand({
    commandId: crypto.randomUUID(),
    expectedVersion: deliverable.version ?? null,
    type: "start_activity",
    targetType: "deliverable",
    targetId: id,
    plannedMinutes: directive.recommendedMinutes,
    stepId: a!.id
  } as never);
  await sql`UPDATE actions SET status='archived'::action_status WHERE id=${a!.id}`;
  // the answer's state read may reject the archived step; the write itself has been committed either way
  await store
    .runActivityCommand({
      commandId: crypto.randomUUID(),
      expectedVersion: started.activeSession?.version ?? null,
      type: "finish_activity",
      sessionId: started.activeSession!.id,
      outcome: "completed"
    } as never)
    .catch(() => undefined);
  expect(await statusOf(a!.id)).toBe("archived");
});
