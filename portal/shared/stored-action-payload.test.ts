import { describe, expect, it } from "vitest";
import { saveActionCommandSchema } from "@openrhen/contracts";
import type { StoredAction } from "@/state/portal-state";
import { storedActionPayload } from "./stored-action-payload";

const stored = (overrides: Partial<StoredAction> = {}): StoredAction =>
  ({
    id: "action-1",
    version: 4,
    projectId: "project-1",
    title: "Mark essays",
    status: "active",
    optimisticMinutes: 20,
    expectedMinutes: 30,
    pessimisticMinutes: 45,
    remainingMinutes: 30,
    energy: "medium",
    minimumSessionMinutes: 15,
    maximumSessionMinutes: 60,
    splittable: true,
    setupMinutes: 5,
    importance: 4,
    consequence: 3,
    contexts: ["home"],
    dependencyIds: ["dep-1"],
    schedulingMode: "one_off",
    requirementPathways: [
      { id: "p1", contextIds: ["home"] },
      { id: "p2", contextIds: ["laptop", "quiet"] }
    ],
    preferences: ["morning"],
    notes: "Rubric is in the shared folder.",
    private: false,
    deadlineAt: "2026-10-09T01:00:00.000Z",
    ...overrides
  }) as unknown as StoredAction;

describe("storedActionPayload", () => {
  it("carries every requirement route, not only the first", () => {
    const payload = storedActionPayload(stored());
    expect(payload.requirementPathways).toEqual([
      { id: "p1", contextIds: ["home"] },
      { id: "p2", contextIds: ["laptop", "quiet"] }
    ]);
    expect(payload).toMatchObject({
      contexts: ["home"],
      preferences: ["morning"],
      private: false,
      deadlineAt: "2026-10-09T01:00:00.000Z",
      dependencyIds: ["dep-1"],
      schedulingMode: "one_off"
    });
  });

  it("keeps a tagged person requirement exactly as stored, and the command still accepts it", () => {
    const payload = storedActionPayload(
      stored({ requirementPathways: [{ id: "p1", contextIds: ["garage", "pete@with"] }] })
    );
    expect(payload.requirementPathways).toEqual([{ id: "p1", contextIds: ["garage", "pete@with"] }]);
    expect(saveActionCommandSchema.shape.action.safeParse(payload).success).toBe(true);
  });

  it("applies overrides on top, and leaves prerequisites and prep to the server's keep-if-absent", () => {
    const payload = storedActionPayload(stored({ prepForCommitmentId: "c1" }), { status: "blocked" });
    expect(payload.status).toBe("blocked");
    expect(payload).not.toHaveProperty("prerequisites");
    expect(payload).not.toHaveProperty("prepForCommitmentId");
  });

  it("never resends notes, so the server keeps them and an imported note over the 5000 cap still validates", () => {
    const long = stored({ notes: "x".repeat(6000) });
    const payload = storedActionPayload(long, { status: "blocked" });
    expect(payload).not.toHaveProperty("notes");
    expect(saveActionCommandSchema.safeParse({ expectedVersion: 4, action: payload }).success).toBe(true);
  });

  it("omits dates that are not stored, and keeps the recurrence", () => {
    const recurrence = {
      id: "r1",
      timezone: "Australia/Sydney",
      startDate: "2026-08-19",
      intervalDays: 1,
      windows: []
    };
    const payload = storedActionPayload(
      stored({ notes: undefined, deadlineAt: undefined, recurrence, schedulingMode: "recurring" } as never)
    );
    expect(payload).not.toHaveProperty("deadlineAt");
    expect(payload.recurrence).toBe(recurrence);
  });

  it("is a valid save_action payload, so the route accepts the read shape's pathways as they are", () => {
    const parsed = saveActionCommandSchema.safeParse({
      expectedVersion: 4,
      action: storedActionPayload(stored(), { status: "waiting" })
    });
    expect(parsed.success).toBe(true);
  });
});
