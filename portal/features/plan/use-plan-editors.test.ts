// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { FormEvent } from "react";
import "@/test/render";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { usePlanEditors } from "./use-plan-editors";

const submitEvent = { preventDefault: () => {} } as unknown as FormEvent;

const saveProjectCommand = vi.fn().mockResolvedValue(undefined);
const saveActionCommand = vi.fn().mockResolvedValue(undefined);
const saveEntityCommand = vi.fn().mockResolvedValue(undefined);
const endRecurrenceGoalCommand = vi.fn().mockResolvedValue(undefined);
const recordCadenceCompletionCommand = vi.fn().mockResolvedValue(undefined);
let state: PortalState;

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state,
    saveProjectCommand,
    saveActionCommand,
    saveEntityCommand,
    endRecurrenceGoalCommand,
    recordCadenceCompletionCommand
  })
}));

beforeEach(() => {
  state = createSeedState(new Date("2026-08-18T09:00:00.000Z"));
  saveProjectCommand.mockClear();
  saveActionCommand.mockClear();
  saveEntityCommand.mockClear();
  endRecurrenceGoalCommand.mockClear();
  recordCadenceCompletionCommand.mockClear();
});

describe("usePlanEditors", () => {
  it("starts with nothing open", () => {
    const { result } = renderHook(() => usePlanEditors());
    expect(result.current.openEditor).toBeNull();
  });

  it("loads the record into its draft and opens the matching sheet", () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openEdit("area", state.areas[0]!));
    expect(result.current.openEditor).toBe("area");
    expect(result.current.area.id).toBe(state.areas[0]!.id);
    expect(result.current.area.name).toBe(state.areas[0]!.name);
  });

  it("closes on Escape-equivalent close() without saving anything", () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openEdit("project", state.projects[0]!));
    expect(result.current.openEditor).toBe("project");
    act(() => result.current.close());
    expect(result.current.openEditor).toBeNull();
  });

  it("clears a standing error when the sheet is closed", async () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("area"));
    act(() => result.current.setArea({ ...result.current.area, name: "" }));
    await act(async () => {
      await result.current.saveArea(submitEvent);
    });
    expect(result.current.error).toBe("Area name is required.");
    act(() => result.current.close());
    expect(result.current.error).toBe("");
  });

  it("pre-fills a new outcome's area from the preset an area page hands it", () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("outcome", { areaId: "area-home" }));
    expect(result.current.openEditor).toBe("outcome");
    expect(result.current.outcome.areaId).toBe("area-home");
    expect(result.current.outcome.id).toBe("");
  });

  it("pre-fills a new project's outcome and a new action's project from presets", () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("project", { outcomeId: "outcome-room" }));
    expect(result.current.project.outcomeId).toBe("outcome-room");
    act(() => result.current.openCreate("action", { projectId: "clean-room" }));
    expect(result.current.action.projectId).toBe("clean-room");
  });

  it("carries a project preset through to the deliverable form", () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("deliverable", { projectId: "clean-room" }));
    expect(result.current.openEditor).toBe("deliverable");
    expect(result.current.deliverablePresetProjectId).toBe("clean-room");
  });

  it("closes the sheet once a project save succeeds", async () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openEdit("project", state.projects[0]!));
    await act(async () => {
      await result.current.saveProject(submitEvent);
    });
    expect(saveProjectCommand).toHaveBeenCalledTimes(1);
    expect(result.current.openEditor).toBeNull();
    expect(result.current.error).toBe("");
  });

  it("leaves the sheet open and reports the reason when a save is rejected as invalid", async () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("area"));
    act(() => result.current.setArea({ ...result.current.area, name: "" }));
    await act(async () => {
      await result.current.saveArea(submitEvent);
    });
    expect(saveEntityCommand).not.toHaveBeenCalled();
    expect(result.current.openEditor).toBe("area");
    expect(result.current.error).toBe("Area name is required.");
  });

  it("leaves the sheet open and surfaces the command's failure when the server rejects a save", async () => {
    saveActionCommand.mockRejectedValueOnce(new Error("Stale version."));
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openEdit("action", state.actions[0]!));
    await act(async () => {
      await result.current.saveAction(submitEvent);
    });
    expect(result.current.openEditor).toBe("action");
    expect(result.current.error).toBe("Stale version.");
  });

  it("closes the sheet once a deliverable is registered, and again once one is updated", async () => {
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("deliverable", { projectId: "clean-room" }));
    let registered = false;
    await act(async () => {
      registered = await result.current.registerDeliverable({
        projectId: "clean-room",
        title: "New deliverable",
        externalDeadlineAt: "",
        internalDeadlineAt: "",
        uncertainty: "some",
        dependencyIds: [],
        importance: 3,
        consequence: 3,
        private: false
      });
    });
    expect(registered).toBe(true);
    expect(result.current.openEditor).toBeNull();

    act(() => result.current.openCreate("deliverable", { projectId: "clean-room" }));
    const stored = {
      id: "deliverable-1",
      projectId: "clean-room",
      title: "Existing",
      status: "needs_breakdown" as const,
      contractVersion: 0,
      planVersion: 0,
      sortOrder: 0,
      sourceIds: [],
      sourceFiles: [],
      steps: [],
      criteria: [],
      blockers: [],
      contractProposals: [],
      uncertainty: "some" as const,
      importance: 3,
      consequence: 3,
      dependencyIds: []
    };
    let updated = false;
    await act(async () => {
      updated = await result.current.updateDeliverable(stored, {
        projectId: "clean-room",
        title: "Renamed",
        externalDeadlineAt: "",
        internalDeadlineAt: "",
        uncertainty: "some",
        dependencyIds: [],
        importance: 3,
        consequence: 3,
        private: false
      });
    });
    expect(updated).toBe(true);
    expect(result.current.openEditor).toBeNull();
  });

  it("records a cadence completion and ends a recurrence goal without touching sheet state", async () => {
    const { result } = renderHook(() => usePlanEditors());
    await act(async () => {
      result.current.recordCadenceCompletion(state.actions[0]!);
      result.current.endRecurrenceGoal(state.actions[0]!);
    });
    expect(recordCadenceCompletionCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "record_cadence_completion", actionId: state.actions[0]!.id })
    );
    expect(endRecurrenceGoalCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "end_recurrence_goal", actionId: state.actions[0]!.id })
    );
    expect(result.current.openEditor).toBeNull();
  });

  it("reuses one area id when a failed save is retried, and mints a fresh one for the next draft", async () => {
    saveEntityCommand.mockRejectedValueOnce(new Error("lost"));
    const { result } = renderHook(() => usePlanEditors());
    act(() => result.current.openCreate("area"));
    act(() => result.current.setArea({ ...result.current.area, name: "Garden" }));
    await act(async () => {
      await result.current.saveArea(submitEvent);
    });
    await act(async () => {
      await result.current.saveArea(submitEvent);
    });
    const ids = saveEntityCommand.mock.calls.map((c) => c[0].entity.id);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    act(() => result.current.openCreate("area"));
    act(() => result.current.setArea({ ...result.current.area, name: "Shed" }));
    await act(async () => {
      await result.current.saveArea(submitEvent);
    });
    expect(saveEntityCommand.mock.calls[2]![0].entity.id).not.toBe(ids[0]);
  });
});
