import { describe, expect, it, vi } from "vitest";
import { portalStateSchema } from "@openrhen/contracts";
import { GET as getState } from "@/app/api/state/route";
import { runWithActor } from "@/server/agent-actor";
import { closeEntity } from "./close-commands";
import { daytimeSeed, fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * Closing a done deliverable step leaves it `archived` in `actions` (a cancelled one stays `cancelled`). The state read
 * must still parse it, the editor re-sends it on the next save, and a save must still be unable to close a step or move
 * one between closed states (#31, archive-removals design section 7).
 */
setupStateStoreSuite("openrhen_deliverable_closed_step");

// The real route, reading the suite's own database instead of the process-wide DATABASE_URL.
vi.mock("@/server/persistence/state-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/persistence/state-store")>();
  const harness = await import("./state-store-harness");
  return { ...actual, getStateStore: () => harness.store };
});

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
    steps: [step("step-a", "Build the diagram", "done"), step("step-b", "Write the explanation")],
    criteria: [{ key: "c", title: "Connectivity", required: true, stepIds: ["step-a", "step-b"] }]
  };
  const state = await save(entity);
  const deliverable = state.deliverables.find((item) => item.id === id)!;
  // A step's id is stored as a derived uuid, so the tests name steps by what the state read hands back.
  const stepA = deliverable.steps.find((item) => item.title === "Build the diagram")!.id;
  const stepB = deliverable.steps.find((item) => item.title === "Write the explanation")!.id;
  return { entity, id, deliverable, stepA, stepB };
}

const statusOf = async (stepId: string) =>
  (await sql<{ status: string }[]>`SELECT status::text AS status FROM actions WHERE id=${stepId}`)[0]!.status;

const asAgent = <T>(run: () => Promise<T>) => runWithActor("claude", run, undefined, undefined, ["write:entity:*"]);

/** The deliverable as the editor holds it after a state read: every step, with the closed one as stored. */
const resend = async (id: string) => {
  const current = (await store.get())!.deliverables.find((item) => item.id === id)!;
  return { current, entity: { ...current, steps: current.steps } };
};

describe("a closed deliverable step", () => {
  it("closing a done step leaves the state read parsing, through the state route", async () => {
    const { stepA } = await setup();
    const done = { id: stepA };
    const closed = await closeEntity(sql, { type: "action", id: done.id, verb: "archive", do: "close" } as never);
    expect(closed.closed.status).toBe("archived");
    expect(await statusOf(done.id)).toBe("archived");

    const response = await getState(new Request("http://localhost/api/state"), {
      params: Promise.resolve({})
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { state: unknown };
    const parsed = portalStateSchema.parse(body.state);
    const read = parsed.deliverables.flatMap((item) => item.steps).find((item) => item.id === done.id);
    expect(read?.status).toBe("archived");
  });

  it.each(["archived", "cancelled"])(
    "re-saving the deliverable with its %s step sent back unchanged round-trips",
    async (closed) => {
      const { id, stepA } = await setup();
      await sql`UPDATE actions SET status=${closed}::action_status WHERE id=${stepA}`;
      const { entity } = await resend(id);
      expect(entity.steps.find((item) => item.id === stepA)?.status).toBe(closed);
      const state = await save({ ...entity, title: "Assessment 2 (renamed)" }, entity.version ?? null);
      expect(state.deliverables.find((item) => item.id === id)?.title).toBe("Assessment 2 (renamed)");
      expect(await statusOf(stepA)).toBe(closed);
    }
  );

  it("a person's save cannot move a step to archived", async () => {
    const { id, stepB } = await setup();
    const { entity } = await resend(id);
    const withStatus = (stepId: string, status: string) => ({
      ...entity,
      steps: entity.steps.map((item) => (item.id === stepId ? { ...item, status } : item))
    });
    await expect(save(withStatus(stepB, "archived"), entity.version ?? null)).rejects.toThrow(/status/i);
    expect(await statusOf(stepB)).toBe("planned");
  });

  it("an agent's save cannot move a step to archived or cancelled, and the floor still holds", async () => {
    const { id, stepB } = await setup();
    const { entity } = await resend(id);
    for (const closed of ["archived", "cancelled"]) {
      await expect(
        asAgent(() =>
          save(
            { ...entity, steps: entity.steps.map((item) => (item.id === stepB ? { ...item, status: closed } : item)) },
            entity.version ?? null
          )
        )
      ).rejects.toThrow();
      expect(await statusOf(stepB)).toBe("planned");
    }
  });
});
