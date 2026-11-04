import { describe, expect, it } from "vitest";
import { openPrepFor } from "@openrhen/contracts";
import { createSeedState } from "@/state/portal-state";
import { InvalidCommandError } from "./command-errors";
import { fixedNow, setupStateStoreSuite, sql, store } from "./state-store-harness";

/**
 * the design notes: a commitment's `attendance` and `preferredLocationId`, and an
 * action's `prepForCommitmentId`, persist and read back; a preference only survives on a remote
 * commitment; and a cancelled commitment's open prep can be listed from the state the save returns.
 */
setupStateStoreSuite("openrhen_commitment_attendance");

const startsAt = new Date(fixedNow.getTime() + 86_400_000).toISOString();
const endsAt = new Date(fixedNow.getTime() + 86_400_000 + 3_600_000).toISOString();

const saveCommitment = (entity: Record<string, unknown>, expectedVersion: number | null = null) =>
  store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion,
    type: "save_entity",
    entityType: "commitment",
    entity: {
      id: "camp-day-1",
      title: "Quantum Tech Camp day 1",
      startsAt,
      endsAt,
      status: "confirmed",
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      ...entity
    }
  });

const camp = (state: { commitments: { title: string }[] }) =>
  state.commitments.find((item) => /camp day 1/i.test(item.title)) as (typeof state.commitments)[number] &
    Record<string, any>;

async function withDesk() {
  await store.put(createSeedState(fixedNow));
  return store.saveEntity({
    commandId: crypto.randomUUID(),
    expectedVersion: null,
    type: "save_entity",
    entityType: "condition_definition",
    entity: { id: "desk", name: "Home desk", kind: "location", latitude: -33.87, longitude: 151.21 }
  });
}

describe("commitment attendance", () => {
  it("defaults to in person and reads back nothing extra", async () => {
    await withDesk();
    const state = await saveCommitment({});
    const commitment = camp(state);
    expect(commitment?.attendance).toBeUndefined();
    expect(commitment?.preferredLocationId).toBeUndefined();
    const rows = await sql<
      { attendance: string }[]
    >`SELECT attendance FROM commitments WHERE title = 'Quantum Tech Camp day 1'`;
    expect(rows.map((row) => row.attendance)).toEqual(["in_person"]);
  });

  it("stores a remote commitment with its preferred location, and keeps both on a silent re-save", async () => {
    await withDesk();
    let state = await saveCommitment({ attendance: "remote", preferredLocationId: "desk" });
    let commitment = camp(state)!;
    expect(commitment.attendance).toBe("remote");
    expect(commitment.preferredLocationId).toBe("desk");
    // An editor that never heard of the fields must not reset them.
    state = await saveCommitment({ title: "Camp day 1 (moved)" }, commitment.version ?? null);
    commitment = camp(state)!;
    expect(commitment.attendance).toBe("remote");
    expect(commitment.preferredLocationId).toBe("desk");
    // An empty string clears the preference without changing attendance.
    state = await saveCommitment({ preferredLocationId: "" }, commitment.version ?? null);
    commitment = camp(state)!;
    expect(commitment.attendance).toBe("remote");
    expect(commitment.preferredLocationId).toBeUndefined();
  });

  it("drops the preference when the commitment goes back to in person", async () => {
    await withDesk();
    let state = await saveCommitment({ attendance: "remote", preferredLocationId: "desk" });
    const version = camp(state)!.version ?? null;
    state = await saveCommitment({ attendance: "in_person", preferredLocationId: "desk" }, version);
    const commitment = camp(state)!;
    expect(commitment.attendance).toBeUndefined();
    expect(commitment.preferredLocationId).toBeUndefined();
  });

  it("refuses an unknown attendance or a preferred place that is not an active location", async () => {
    await withDesk();
    await expect(saveCommitment({ attendance: "hybrid" })).rejects.toThrow(InvalidCommandError);
    await expect(saveCommitment({ attendance: "remote", preferredLocationId: "nowhere" })).rejects.toThrow(
      InvalidCommandError
    );
  });
});

describe("prep attached to a commitment", () => {
  const prepOf = (state: { actions: { title: string }[] }) =>
    state.actions.find((item) => item.title.startsWith("Print the")) as any;
  const prepAction = (projectId: string, overrides: Record<string, unknown> = {}) => ({
    id: "prep-print",
    projectId,
    title: "Print the camp briefing",
    status: "planned" as const,
    optimisticMinutes: 5,
    expectedMinutes: 10,
    pessimisticMinutes: 15,
    remainingMinutes: 10,
    energy: "low" as const,
    minimumSessionMinutes: 5,
    maximumSessionMinutes: 10,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 3,
    contexts: [],
    dependencyIds: [],
    ...overrides
  });

  it("stores and returns prepForCommitmentId, keeps it on a silent re-save, and detaches on null", async () => {
    await withDesk();
    let state = await saveCommitment({});
    const commitment = camp(state)!;
    const projectId = state.projects[0]!.id;
    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: null,
      action: prepAction(projectId, { prepForCommitmentId: commitment.id })
    });
    let action = prepOf(state)!;
    expect(action.prepForCommitmentId).toBe(commitment.id);

    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      action: prepAction(projectId, { title: "Print the briefing" })
    });
    action = prepOf(state)!;
    expect(action.prepForCommitmentId).toBe(commitment.id);

    state = await store.saveAction({
      commandId: crypto.randomUUID(),
      expectedVersion: action.version ?? null,
      action: prepAction(projectId, { prepForCommitmentId: null })
    });
    expect(prepOf(state)?.prepForCommitmentId).toBeUndefined();
  });

  it("refuses prep for a commitment that does not exist", async () => {
    await withDesk();
    const state = await saveCommitment({});
    await expect(
      store.saveAction({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        action: prepAction(state.projects[0]!.id, { prepForCommitmentId: crypto.randomUUID() })
      })
    ).rejects.toThrow("no longer exists");
  });

  it("lists the open prep of a commitment from the state its cancellation returns", async () => {
    await withDesk();
    let state = await saveCommitment({});
    const commitment = camp(state)!;
    const projectId = state.projects[0]!.id;
    for (const [id, status] of [
      ["prep-open", "planned"],
      ["prep-done", "done"]
    ] as const)
      state = await store.saveAction({
        commandId: crypto.randomUUID(),
        expectedVersion: null,
        action: prepAction(projectId, { id, title: id, status, prepForCommitmentId: commitment.id })
      });
    state = await saveCommitment({ status: "cancelled" }, commitment.version ?? null);
    expect(state.commitments.find((item) => item.id === commitment.id)?.status).toBe("cancelled");
    expect(openPrepFor(state.actions, commitment.id).map((item) => item.title)).toEqual(["prep-open"]);
  });
});
