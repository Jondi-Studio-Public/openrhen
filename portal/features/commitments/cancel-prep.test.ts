import { describe, expect, it, vi } from "vitest";
import type { StoredAction } from "@/state/portal-state";
import { cancelPrep, cancelPrepCommand, openPrepOf } from "./cancel-prep";

const action = (id: string, status: string, prepFor?: string): StoredAction =>
  ({
    id,
    version: 2,
    projectId: "p1",
    title: `Prep ${id}`,
    status,
    optimisticMinutes: 5,
    expectedMinutes: 10,
    pessimisticMinutes: 15,
    remainingMinutes: 10,
    energy: "low",
    minimumSessionMinutes: 5,
    maximumSessionMinutes: 10,
    splittable: true,
    setupMinutes: 0,
    importance: 3,
    consequence: 4,
    contexts: ["home"],
    dependencyIds: ["dep"],
    deadlineAt: "2026-10-01T08:55:00.000Z",
    schedulingMode: "one_off",
    requirementPathways: [],
    preferences: [],
    ...(prepFor ? { prepForCommitmentId: prepFor } : {})
  }) as unknown as StoredAction;

describe("cancel prep", () => {
  it("lists the commitment's open prep only", () => {
    const actions = [
      action("a", "planned", "c1"),
      action("b", "done", "c1"),
      action("c", "planned", "c2"),
      action("d", "cancelled", "c1"),
      action("e", "doing", "c1")
    ];
    expect(openPrepOf(actions, "c1").map((item) => item.id)).toEqual(["a", "e"]);
    expect(openPrepOf(actions, "")).toEqual([]);
  });

  it("restates the action with only its status changed, at the version in hand", () => {
    const command = cancelPrepCommand(action("a", "planned", "c1"));
    expect(command.expectedVersion).toBe(2);
    expect(command.action).toMatchObject({
      id: "a",
      status: "cancelled",
      title: "Prep a",
      consequence: 4,
      dependencyIds: ["dep"],
      deadlineAt: "2026-10-01T08:55:00.000Z",
      schedulingMode: "one_off"
    });
    // Absent, so the server keeps the stored attachment; the routes go back as stored.
    expect(command.action).not.toHaveProperty("prepForCommitmentId");
    expect(command.action.requirementPathways).toEqual([]);
  });

  it("cancels each in turn and stops at the first refusal", async () => {
    const save = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Changed elsewhere"));
    await expect(
      cancelPrep([action("a", "planned"), action("b", "planned"), action("c", "planned")], save)
    ).rejects.toThrow("Changed elsewhere");
    expect(save).toHaveBeenCalledTimes(2);
  });
});
