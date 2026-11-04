"use client";

import { useState, type FormEvent } from "react";
import { useDraftId } from "@/components/form-actions";
import { usePortal } from "@/state/portal-provider";
import type { StoredAction, StoredArea, StoredDeliverable, StoredOutcome, StoredProject } from "@/state/portal-state";
import {
  actionDraftFrom,
  areaDraftFrom,
  emptyAction,
  emptyArea,
  emptyOutcome,
  emptyProject,
  outcomeDraftFrom,
  projectDraftFrom,
  type ActionDraft,
  type AreaDraft,
  type DeliverableDraft,
  type OutcomeDraft,
  type ProjectDraft
} from "@/features/plan/plan-drafts";
import {
  actionCommand,
  areaCommand,
  cadenceCompletionCommand,
  deliverableCommand,
  deliverableUpdateCommand,
  outcomeCommand,
  projectCommand,
  recurrenceGoalEndCommand,
  validateActionDraft,
  validateAreaDraft,
  validateDeliverableDraft,
  validateOutcomeDraft,
  validateProjectDraft
} from "@/features/plan/plan-commands";

/** The five things Plan edits in a popup, one at a time. */
export type PlanEditorKind = "area" | "outcome" | "project" | "deliverable" | "action";

/**
 * What an area page pre-fills on a brand new item, so "New project" on `/plan/[areaId]` does not
 * hand back a blank outcome picker the visitor has to fill in by hand.
 */
export interface PlanEditorPresets {
  areaId?: string | undefined;
  outcomeId?: string | undefined;
  projectId?: string | undefined;
}

/**
 * The draft state, save handlers, and open/closed sheet state every Plan editor needs — moved out of
 * the page components so `/plan` and `/plan/[areaId]` can share one implementation. A successful save
 * closes whichever sheet is open; a failed one leaves it open with `error` set.
 */
export function usePlanEditors() {
  const {
    state,
    saveProjectCommand,
    saveActionCommand,
    saveEntityCommand,
    endRecurrenceGoalCommand,
    recordCadenceCompletionCommand
  } = usePortal();
  const [area, setArea] = useState<AreaDraft>(emptyArea);
  const [outcome, setOutcome] = useState<OutcomeDraft>(emptyOutcome);
  const [project, setProject] = useState<ProjectDraft>(emptyProject);
  const [action, setAction] = useState<ActionDraft>(() => emptyAction(state.settings.timezone));
  const [deliverablePresetProjectId, setDeliverablePresetProjectId] = useState("");
  const [openEditor, setOpenEditor] = useState<PlanEditorKind | null>(null);
  const [error, setError] = useState("");
  // A new record keeps one id from the first save attempt until the draft is saved, replaced or closed.
  const draftId = useDraftId();

  function close() {
    draftId.reset();
    setOpenEditor(null);
    setError("");
  }

  function openEdit(kind: "area", item: StoredArea): void;
  function openEdit(kind: "outcome", item: StoredOutcome): void;
  function openEdit(kind: "project", item: StoredProject): void;
  function openEdit(kind: "action", item: StoredAction): void;
  function openEdit(
    kind: Exclude<PlanEditorKind, "deliverable">,
    item: StoredArea | StoredOutcome | StoredProject | StoredAction
  ) {
    setError("");
    draftId.reset();
    if (kind === "area") setArea(areaDraftFrom(item as StoredArea));
    else if (kind === "outcome") setOutcome(outcomeDraftFrom(item as StoredOutcome, state.settings.timezone));
    else if (kind === "project") setProject(projectDraftFrom(item as StoredProject, state.settings.timezone));
    else setAction(actionDraftFrom(item as StoredAction, state.settings.timezone));
    setOpenEditor(kind);
  }

  function openCreate(kind: PlanEditorKind, presets: PlanEditorPresets = {}) {
    setError("");
    draftId.reset();
    if (kind === "area") setArea(emptyArea());
    else if (kind === "outcome") setOutcome({ ...emptyOutcome(), areaId: presets.areaId ?? "" });
    else if (kind === "project") setProject({ ...emptyProject(), outcomeId: presets.outcomeId ?? "" });
    else if (kind === "action")
      setAction({ ...emptyAction(state.settings.timezone), projectId: presets.projectId ?? "" });
    else setDeliverablePresetProjectId(presets.projectId ?? "");
    setOpenEditor(kind);
  }

  async function saveArea(event: FormEvent) {
    event.preventDefault();
    const invalid = validateAreaDraft(area, state.areas);
    if (invalid) return setError(invalid);
    try {
      await saveEntityCommand(areaCommand(area, state, draftId.current()));
      setArea(emptyArea());
      setError("");
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The area was not saved.");
    }
  }

  async function saveOutcome(event: FormEvent) {
    event.preventDefault();
    const invalid = validateOutcomeDraft(outcome);
    if (invalid) return setError(invalid);
    try {
      await saveEntityCommand(outcomeCommand(outcome, state, draftId.current()));
      setOutcome(emptyOutcome());
      setError("");
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The outcome was not saved.");
    }
  }

  async function saveProject(event: FormEvent) {
    event.preventDefault();
    const invalid = validateProjectDraft(project, state.settings.timezone, state);
    if (invalid) return setError(invalid);
    try {
      await saveProjectCommand(projectCommand(project, state, draftId.current()));
      setProject(emptyProject());
      setError("");
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The project was not saved.");
    }
  }

  async function saveAction(event: FormEvent) {
    event.preventDefault();
    const invalid = validateActionDraft(action, state.actions, state);
    if (invalid) return setError(invalid);
    try {
      await saveActionCommand(actionCommand(action, state, draftId.current()));
      setAction(emptyAction(state.settings.timezone));
      setError("");
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The action was not saved.");
    }
  }

  async function registerDeliverable(draft: DeliverableDraft) {
    const invalid = validateDeliverableDraft(draft, state.settings.timezone, undefined, state);
    if (invalid) {
      setError(invalid);
      return false;
    }
    try {
      await saveEntityCommand(deliverableCommand(draft, state));
      setError("");
      close();
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The deliverable was not registered.");
      return false;
    }
  }

  async function updateDeliverable(stored: StoredDeliverable, draft: DeliverableDraft) {
    const invalid = validateDeliverableDraft(draft, state.settings.timezone, stored.id, state);
    if (invalid) {
      setError(invalid);
      return false;
    }
    try {
      await saveEntityCommand(deliverableUpdateCommand(stored, draft, state.settings.timezone));
      setError("");
      close();
      return true;
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The deliverable was not updated.");
      return false;
    }
  }

  /** Fire-and-forget: these act on a project card's own action row, not on anything a sheet holds open. */
  function endRecurrenceGoal(item: StoredAction) {
    void endRecurrenceGoalCommand(recurrenceGoalEndCommand(item)).catch((endError) =>
      setError(endError instanceof Error ? endError.message : "The goal could not be marked complete.")
    );
  }

  function recordCadenceCompletion(item: StoredAction) {
    void recordCadenceCompletionCommand(cadenceCompletionCommand(item)).catch((recordError) =>
      setError(recordError instanceof Error ? recordError.message : "Today's cadence could not be recorded.")
    );
  }

  return {
    area,
    setArea,
    outcome,
    setOutcome,
    project,
    setProject,
    action,
    setAction,
    deliverablePresetProjectId,
    openEditor,
    openEdit,
    openCreate,
    close,
    error,
    setError,
    saveArea,
    saveOutcome,
    saveProject,
    saveAction,
    registerDeliverable,
    updateDeliverable,
    endRecurrenceGoal,
    recordCadenceCompletion
  };
}

export type UsePlanEditors = ReturnType<typeof usePlanEditors>;
