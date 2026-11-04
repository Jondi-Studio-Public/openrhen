import { describe, expect, it } from "vitest";
import { formatAgentCall } from "@openrhen/contracts";
import { runWithActor } from "@/server/agent-actor";
import { closeEntity } from "./close-commands";
import { daytimeSeed, fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * A deliverable save that leaves a step out used to delete it, for anyone. An agent's save no longer does (archive-removals
 * design section 7, PR 7b, the agent half of #30): an open or done step it omits is refused before anything is written,
 * with the exact cancel or archive call for each, and a step that is already closed is kept. The person's save and the
 * owner's confirmation of an agent's still drop the steps a save leaves out. Its own `_test` database.
 */
setupStateStoreSuite("openrhen_deliverable_step_drop");

const step = (key: string, title: string, status = "planned") => ({
  id: key,
  title,
  status,
  optimisticMinutes: 20,
  expectedMinutes: 30,
  pessimisticMinutes: 45,
  remainingMinutes: 30,
  energy: "low",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60
});

const save = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "deliverable",
    entity
  } as never);

const asAgent = <T>(run: () => Promise<T>) => runWithActor("claude", run, undefined, undefined, ["write:entity:*"]);
const asConfirmedAgent = <T>(run: () => Promise<T>) => runWithActor("claude", run, "owner");

async function setup() {
  await store.put(daytimeSeed(new Date()));
  const project = (await store.get())!.projects[0]!;
  const id = crypto.randomUUID();
  const entity = {
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
    steps: [
      step("step-a", "Build the diagram", "done"),
      step("step-b", "Write the explanation"),
      step("step-c", "Proofread")
    ]
  };
  const state = await save(entity);
  const deliverable = state.deliverables.find((item) => item.id === id)!;
  const idOf = (title: string) => deliverable.steps.find((item) => item.title === title)!.id;
  return {
    id,
    stepA: idOf("Build the diagram"),
    stepB: idOf("Write the explanation"),
    stepC: idOf("Proofread")
  };
}

const resend = async (id: string) => (await store.get())!.deliverables.find((item) => item.id === id)!;
const without = (deliverable: Awaited<ReturnType<typeof resend>>, ...ids: string[]) => ({
  ...deliverable,
  steps: deliverable.steps.filter((item) => !ids.includes(item.id))
});
const stepRow = async (stepId: string) =>
  (
    await sql<
      { status: string; version: number }[]
    >`SELECT status::text AS status, version FROM actions WHERE id=${stepId}`
  )[0];

describe("a deliverable save that leaves steps out", () => {
  it("an agent's save omitting an open and a done step is refused with the exact close call for each, and writes nothing", async () => {
    const { id, stepA, stepB, stepC } = await setup();
    const current = await resend(id);
    const before = { a: await stepRow(stepA), b: await stepRow(stepB), c: await stepRow(stepC) };
    const error = (await asAgent(() => save(without(current, stepA, stepB), current.version ?? null)).catch(
      (e: unknown) => e
    )) as Error & { nextCall?: { tool: string; arguments: Record<string, unknown> } };
    expect(error).toBeInstanceOf(Error);
    const cancel = formatAgentCall({
      tool: "rhen_cancel",
      arguments: {
        type: "action",
        id: stepB,
        do: "close",
        "expected-version": before.b!.version,
        reason: "<why the step is dropped>"
      }
    });
    const archive = formatAgentCall({
      tool: "rhen_archive",
      arguments: {
        type: "action",
        id: stepA,
        do: "close",
        "expected-version": before.a!.version,
        reason: "<why the step is dropped>"
      }
    });
    expect(error.message).toContain(`is planned: cancel it with ${cancel}`);
    expect(error.message).toContain(`is done: archive it with ${archive}`);
    expect(error.message).toContain("2 steps");
    expect(error.message).not.toContain(stepC);
    expect({ a: await stepRow(stepA), b: await stepRow(stepB), c: await stepRow(stepC) }).toEqual(before);
  });

  it("a step the agent cancels first can then be left out, and is kept as cancelled, not deleted", async () => {
    const { id, stepB } = await setup();
    await asAgent(() =>
      closeEntity(sql, { type: "action", id: stepB, verb: "cancel", do: "close", reason: "no longer needed" } as never)
    );
    const current = await resend(id);
    await asAgent(() => save(without(current, stepB), current.version ?? null));
    expect(await stepRow(stepB)).toMatchObject({ status: "cancelled" });
  });

  it("the person's save still deletes a step it leaves out", async () => {
    const { id, stepB } = await setup();
    const current = await resend(id);
    await save(without(current, stepB), current.version ?? null);
    expect(await stepRow(stepB)).toBeUndefined();
  });

  it("the owner's confirmation of an agent's save still deletes the step", async () => {
    const { id, stepB } = await setup();
    const current = await resend(id);
    await asConfirmedAgent(() => save(without(current, stepB), current.version ?? null));
    expect(await stepRow(stepB)).toBeUndefined();
  });

  it("(guard) an agent's save that keeps every step is unaffected", async () => {
    const { id, stepB } = await setup();
    const current = await resend(id);
    await asAgent(() => save({ ...current, title: "Assessment 2 (renamed)" }, current.version ?? null));
    expect((await resend(id)).title).toBe("Assessment 2 (renamed)");
    expect(await stepRow(stepB)).toMatchObject({ status: "planned" });
  });
});
