"use client";

import { useEffect, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from "react";
import { usePortal } from "@/state/portal-provider";
import { RoutineBoard } from "@/features/routines/components/routine-board";
import { RoutineEmptyState } from "@/features/routines/components/routine-empty-state";
import { RoutinePresetSidebar } from "@/features/routines/components/routine-preset-sidebar";
import { RoutineToolbar } from "@/features/routines/components/routine-toolbar";
import { cadenceActionOptions, recurringWindowOptions } from "@/features/routines/recurring-windows";
import {
  newRoutineStep,
  normalizeRoutineLabel,
  removeRoutineStep,
  routineGraphLevels,
  routinePresetDraft,
  routinePresetsForView,
  topologicalRoutineSteps,
  validateRoutineGraph,
  type RoutinePresetDraft
} from "@/features/routines/routine-editor";
import type { RoutinePreset, RoutinePresetStep } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { activeConditionIds } from "@/features/settings/context-summary";
import { routinePresetCommand } from "@/features/routines/routine-commands";
import { DEFAULT_TIME_BANDS } from "@openrhen/contracts";

/**
 * The routine builder: preset list, toolbar, dependency board and save. It is a Settings section, so
 * the same editor mounts inside `/settings` and on its own at `/settings/routines`; the caller
 * supplies the heading (an h1 on the page, an h2 in the section) and this owns everything under it.
 */
export function RoutineEditorSection({ heading }: { heading: ReactNode }) {
  const { state, saving, saveEntityCommand } = usePortal();
  const [draft, setDraft] = useState<RoutinePresetDraft | null>(null);
  const [baseline, setBaseline] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const submittingRef = useRef(false);
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline);
  const graphError = draft ? validateRoutineGraph(draft.steps) : null;
  const visiblePresets = routinePresetsForView(state.routinePresets, showArchived);
  const archivedCount = state.routinePresets.length - routinePresetsForView(state.routinePresets, false).length;
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);
  function openPreset(preset?: RoutinePreset) {
    if (dirty && !window.confirm("Discard your unsaved routine changes?")) return;
    const base = routinePresetDraft(preset);
    const next = preset ? base : { ...base, id: createClientId() };
    setDraft(next);
    setBaseline(JSON.stringify(next));
    setEditingId(null);
    setMessage("");
  }
  function patch(patch: Partial<RoutinePresetDraft>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }
  function patchStep(id: string, change: Partial<RoutinePresetStep>) {
    setDraft((current) =>
      current
        ? { ...current, steps: current.steps.map((step) => (step.id === id ? { ...step, ...change } : step)) }
        : current
    );
  }
  function addStep(phase: "before" | "after" = "before") {
    if (!draft) return;
    const step = newRoutineStep(createClientId(), draft.steps.length, phase);
    setDraft({ ...draft, steps: [...draft.steps, step] });
    setEditingId(step.id);
    setMessage("");
  }
  function deleteStep(id: string) {
    if (!draft) return;
    const index = draft.steps.findIndex((step) => step.id === id);
    setDraft({ ...draft, steps: removeRoutineStep(draft.steps, index) });
    setEditingId(null);
  }
  function connect(sourceId: string, targetId: string) {
    if (!draft || sourceId === targetId) return setMessage("A tile cannot connect to itself.");
    const target = draft.steps.find((step) => step.id === targetId);
    if (!target) return;
    const next = {
      ...draft,
      steps: draft.steps.map((step) =>
        step.id === targetId ? { ...step, dependencyIds: [...new Set([...step.dependencyIds, sourceId])] } : step
      )
    };
    const error = validateRoutineGraph(next.steps);
    if (error) return setMessage(error);
    setDraft(next);
    setMessage("");
  }
  function dropConnection(event: DragEvent, targetId: string) {
    const source = event.dataTransfer.getData("application/x-routine-connection");
    if (source) {
      event.preventDefault();
      connect(source, targetId);
    }
  }
  function reorder(event: DragEvent, targetId: string) {
    const sourceId = event.dataTransfer.getData("application/x-routine-tile");
    if (!draft || !sourceId || sourceId === targetId) return;
    const levels = routineGraphLevels(draft.steps);
    const column = [...levels.before, ...levels.after].find((items) => items.some((step) => step.id === targetId));
    if (!column?.some((step) => step.id === sourceId))
      return setMessage("Tiles can only be reordered within the same dependency level.");
    const source = draft.steps.find((step) => step.id === sourceId)!;
    const target = draft.steps.find((step) => step.id === targetId)!;
    patch({
      steps: draft.steps.map((step) =>
        step.id === sourceId
          ? { ...step, sequence: target.sequence }
          : step.id === targetId
            ? { ...step, sequence: source.sequence }
            : step
      )
    });
    setMessage("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || submittingRef.current) return;
    const name = normalizeRoutineLabel(draft.name);
    const activityName = normalizeRoutineLabel(draft.activityName);
    if (!name || !activityName) return setMessage("Name both the preset and its commitment.");
    const duplicate = state.routinePresets.find(
      (item) => item.id !== draft.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (duplicate) return setMessage(`A routine named “${duplicate.name}” already exists. Open that routine instead.`);
    if (!draft.steps.length) return setMessage("Add at least one preparation tile.");
    if (draft.steps.some((step) => !step.title.trim())) return setMessage("Every preparation tile needs a name.");
    if (graphError) return setMessage(graphError);
    const ordered = topologicalRoutineSteps(draft.steps).map((step, sequence) => ({
      ...step,
      title: normalizeRoutineLabel(step.title),
      sequence
    }));
    const savedDraft = { ...draft, name, activityName, steps: ordered };
    const command = routinePresetCommand(savedDraft, state);
    submittingRef.current = true;
    try {
      await saveEntityCommand(command);
      setMessage("Routine saved and planning evidence recalculated.");
      setEditingId(null);
      setBaseline(JSON.stringify(savedDraft));
      setDraft(savedDraft);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Routine was not saved.");
    } finally {
      submittingRef.current = false;
    }
  }
  return (
    <>
      <div className="routine-page-heading">
        <div>{heading}</div>
        {/* While nothing is open the empty panel carries the one New routine button. */}
        {draft && (
          <button type="button" onClick={() => openPreset()}>
            New routine
          </button>
        )}
      </div>
      <div className="routine-workspace">
        <RoutinePresetSidebar
          presets={visiblePresets}
          showArchived={showArchived}
          archivedCount={archivedCount}
          openId={draft?.id}
          onShowArchivedChange={setShowArchived}
          onOpen={openPreset}
        />
        <section className="routine-canvas-panel">
          {draft ? (
            <form onSubmit={save}>
              <RoutineToolbar
                name={draft.name}
                status={draft.status}
                saving={saving}
                dirty={dirty}
                onNameChange={(name) => patch({ name })}
                onStatusChange={(status) => patch({ status })}
                onAddStep={addStep}
              />
              {message && (
                <p
                  className={message.includes("saved") ? "save-notice routine-message" : "form-error routine-message"}
                  role={message.includes("saved") ? "status" : "alert"}
                >
                  {message}
                </p>
              )}
              <RoutineBoard
                draft={draft}
                editingId={editingId}
                setEditingId={setEditingId}
                patchStep={patchStep}
                deleteStep={deleteStep}
                connect={connect}
                dropConnection={dropConnection}
                reorder={reorder}
                contexts={activeConditionIds(state.conditionDefinitions)}
                recurringWindows={recurringWindowOptions(state.actions)}
                cadenceActions={cadenceActionOptions(state.actions)}
                timeBands={state.settings.timeBands ?? DEFAULT_TIME_BANDS}
                onCommitmentNameChange={(activityName) => patch({ activityName })}
                onReplacesWakeRoutineChange={(replacesWakeRoutine) => patch({ replacesWakeRoutine })}
              />
              <div className="routine-footer">
                <span>{dirty ? "Unsaved changes" : "All changes saved"}</span>
                <button
                  type="button"
                  className="quiet"
                  onClick={() => openPreset(state.routinePresets.find((item) => item.id === draft.id))}
                >
                  Cancel changes
                </button>
              </div>
            </form>
          ) : (
            <RoutineEmptyState onCreate={() => openPreset()} />
          )}
        </section>
      </div>
    </>
  );
}
