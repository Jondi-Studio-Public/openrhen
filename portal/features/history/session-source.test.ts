import { describe, expect, it } from "vitest";
import type { PortalState } from "@/state/portal-state";
import { sessionSource } from "./session-source";

const state = {
  projects: [{ id: "project-1", title: "Thesis" }],
  actions: [{ id: "action-1", projectId: "project-1" }],
  deliverables: [{ id: "deliverable-1", projectId: "project-1" }]
} as unknown as Pick<PortalState, "actions" | "projects" | "deliverables">;

function session(
  targetType: PortalState["completedToday"][number]["targetType"],
  actionId: string
): PortalState["completedToday"][number] {
  return {
    id: "session-1",
    actionId,
    actionTitle: "Draft chapter",
    result: "completed",
    ...(targetType ? { targetType } : {}),
    startedAt: "2026-09-28T22:00:00.000Z",
    endedAt: "2026-09-28T23:00:00.000Z",
    plannedMinutes: 60,
    activeMinutes: 60,
    remainingBeforeMinutes: 0,
    remainingAfterMinutes: 0
  };
}

describe("sessionSource", () => {
  it("names a deliverable session's project through its deliverable, not as an action", () => {
    expect(sessionSource(session("deliverable", "deliverable-1"), state)).toBe("Thesis");
  });

  it("falls back to Deliverable when the deliverable is no longer in the state", () => {
    expect(sessionSource(session("deliverable", "gone"), state)).toBe("Deliverable");
  });

  it("names a commitment session a commitment", () => {
    expect(sessionSource(session("fixed_commitment", "commitment-1"), state)).toBe("Commitment");
  });

  it("names an action session's project, with or without a target type", () => {
    expect(sessionSource(session("action", "action-1"), state)).toBe("Thesis");
    expect(sessionSource(session(undefined, "action-1"), state)).toBe("Thesis");
    expect(sessionSource(session("action", "gone"), state)).toBe("Project unavailable");
  });

  it("keeps the fixed labels for sleep and routines", () => {
    expect(sessionSource(session("sleep", "x"), state)).toBe("Protected sleep");
    expect(sessionSource(session("routine_instance", "x"), state)).toBe("Routine checklist");
    expect(sessionSource(session("routine_step", "x"), state)).toBe("Commitment preparation");
  });
});
