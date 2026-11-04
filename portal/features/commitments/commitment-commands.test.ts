import { describe, expect, it } from "vitest";
import type { StoredCommitment, StoredRoutineStep } from "@/state/portal-state";
import {
  commitmentRoutineSourceCommand,
  routineStepEditCommand,
  splitSourceCommand
} from "@/features/commitments/commitment-commands";

const commitment = (overrides: Partial<StoredCommitment> = {}): StoredCommitment => ({
  id: "dinner",
  version: 4,
  title: "Family dinner",
  startsAt: "2026-08-19T09:00:00.000Z",
  endsAt: "2026-08-19T10:00:00.000Z",
  status: "confirmed",
  setupBeforeMinutes: 15,
  transitionAfterMinutes: 5,
  ...overrides
});

const routineStep = (overrides: Partial<StoredRoutineStep> = {}): StoredRoutineStep =>
  ({
    id: "bins",
    version: 4,
    commitmentId: "dinner",
    title: "Take the bins out",
    durationMinutes: 15,
    sequence: 0,
    timingRule: "flexible" as const,
    maxLeadMinutes: 120,
    energy: "low" as const,
    contexts: ["home"],
    dependencyIds: [],
    phase: "before" as const,
    status: "pending" as const,
    ...overrides
  }) as unknown as StoredRoutineStep;

describe("commitmentRoutineSourceCommand", () => {
  it("claims the commitment's own version and restates every rewritten column", () => {
    const command = commitmentRoutineSourceCommand(commitment({ version: 4 }), "preset", "preset-1");
    expect(command.expectedVersion).toBe(4);
    expect(command.entityType).toBe("commitment");
    expect(command.entity).toMatchObject({
      id: "dinner",
      title: "Family dinner",
      routineSource: "preset",
      routinePresetId: "preset-1"
    });
  });

  it("omits routinePresetId when the source is not preset", () => {
    const command = commitmentRoutineSourceCommand(commitment(), "inherit", "preset-1");
    expect(command.entity).not.toHaveProperty("routinePresetId");
    expect(command.entity.routineSource).toBe("inherit");
  });

  it("saves against no expected version when the commitment has never been stored", () => {
    const command = commitmentRoutineSourceCommand(commitment({ version: undefined }), "custom", "");
    expect(command.expectedVersion).toBeNull();
  });

  it("preserves the share-to-calendar flag rather than defaulting it to false", () => {
    const command = commitmentRoutineSourceCommand(commitment({ shareToCalendar: true }), "none", "");
    expect(command.entity.shareToCalendar).toBe(true);
  });

  it("defaults shareToCalendar to false when the commitment never set it", () => {
    const command = commitmentRoutineSourceCommand(commitment({ shareToCalendar: undefined }), "none", "");
    expect(command.entity.shareToCalendar).toBe(false);
  });

  it("carries location, locationId and projectId through only when the commitment has them", () => {
    const bare = commitmentRoutineSourceCommand(commitment(), "none", "");
    expect(bare.entity).not.toHaveProperty("location");
    expect(bare.entity).not.toHaveProperty("locationId");
    expect(bare.entity).not.toHaveProperty("projectId");
    const located = commitmentRoutineSourceCommand(
      commitment({ location: "Home", locationId: "home-1", projectId: "project-1" }),
      "none",
      ""
    );
    expect(located.entity).toMatchObject({ location: "Home", locationId: "home-1", projectId: "project-1" });
  });
});

describe("routineStepEditCommand", () => {
  it("claims the step's own version and restates every other column unchanged", () => {
    const command = routineStepEditCommand(routineStep({ version: 6 }), { status: "completed" });
    expect(command.expectedVersion).toBe(6);
    expect(command.entityType).toBe("routine_step");
    expect(command.entity).toMatchObject({
      id: "bins",
      commitmentId: "dinner",
      title: "Take the bins out",
      status: "completed"
    });
    // Only status was named; the columns the edit did not touch travel through unchanged.
    expect(command.entity.energy).toBe("low");
    expect(command.entity.durationMinutes).toBe(15);
  });

  it("saves against no expected version when the step has never been stored", () => {
    const command = routineStepEditCommand(routineStep({ version: undefined }), { title: "Take the bins out early" });
    expect(command.expectedVersion).toBeNull();
  });

  it("applies a full edit's changed fields", () => {
    const command = routineStepEditCommand(routineStep(), {
      title: "Water the plants",
      durationMinutes: 10,
      timingRule: "contiguous",
      energy: "high",
      phase: "after"
    });
    expect(command.entity).toMatchObject({
      title: "Water the plants",
      durationMinutes: 10,
      timingRule: "contiguous",
      energy: "high",
      phase: "after"
    });
  });
});

describe("splitSourceCommand", () => {
  it("names the commitment, the link and the version in hand", () => {
    const command = splitSourceCommand(commitment(), "link-1");
    expect(command).toMatchObject({ commitmentId: "dinner", linkId: "link-1", expectedVersion: 4 });
    expect(command.commandId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("refuses a commitment with no version", () => {
    expect(() => splitSourceCommand(commitment({ version: undefined }), "link-1")).toThrow(/not been saved/);
  });
});
