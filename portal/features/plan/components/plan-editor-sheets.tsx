"use client";

import type {
  PortalState,
  StoredArea,
  StoredOutcome,
  StoredProject,
  StoredAction,
  StoredDeliverable
} from "@/state/portal-state";
import { Sheet } from "@/components/sheet";
import type { UsePlanEditors } from "@/features/plan/use-plan-editors";
import { AreaEditor } from "@/features/plan/components/area-editor";
import { OutcomeEditor } from "@/features/plan/components/outcome-editor";
import { ProjectEditor } from "@/features/plan/components/project-editor";
import { DeliverableRegisterForm } from "@/features/plan/components/deliverable-register-form";
import { ActionEditor } from "@/features/plan/components/action-editor";

/**
 * Every Plan editor, one at a time, inside the popup `editors.openEditor` names. The editors
 * themselves are unchanged forms; this only decides which one is on screen and forces it open, since
 * a sheet holds exactly one thing and a collapsed `<summary>` would otherwise leave it looking empty.
 * `/plan` and `/plan/[areaId]` both render this beside their own `usePlanEditors()` instance.
 */
export function PlanEditorSheets({
  editors,
  areas,
  outcomes,
  projects,
  actions,
  deliverables,
  conditionDefinitions,
  timezone
}: {
  editors: UsePlanEditors;
  areas: StoredArea[];
  outcomes: StoredOutcome[];
  projects: StoredProject[];
  actions: StoredAction[];
  deliverables: StoredDeliverable[];
  conditionDefinitions: PortalState["conditionDefinitions"];
  /** The planning timezone the deliverable deadline fields read and write in (finding 30). */
  timezone: string;
}) {
  const kind = editors.openEditor;
  const title =
    kind === "area"
      ? editors.area.id
        ? "Edit area"
        : "Add an area"
      : kind === "outcome"
        ? editors.outcome.id
          ? "Edit outcome"
          : "Add an outcome"
        : kind === "project"
          ? editors.project.id
            ? "Edit project"
            : "Add a project"
          : kind === "action"
            ? editors.action.id
              ? "Edit action"
              : "Add a concrete action"
            : "Register or edit deliverables";

  return (
    <Sheet open={kind !== null} onClose={editors.close} title={title} className="plan-editor-sheet">
      {editors.error && (
        <p className="form-error" role="alert">
          {editors.error}
        </p>
      )}
      {kind === "area" && (
        <AreaEditor
          draft={editors.area}
          onChange={editors.setArea}
          onSubmit={editors.saveArea}
          onCancel={editors.close}
          open
        />
      )}
      {kind === "outcome" && (
        <OutcomeEditor
          draft={editors.outcome}
          areas={areas}
          onChange={editors.setOutcome}
          onSubmit={editors.saveOutcome}
          onCancel={editors.close}
          open
        />
      )}
      {kind === "project" && (
        <ProjectEditor
          draft={editors.project}
          outcomes={outcomes}
          areas={areas}
          projects={projects}
          deliverables={deliverables}
          actions={actions}
          onChange={editors.setProject}
          onSubmit={editors.saveProject}
          onCancel={editors.close}
          open
        />
      )}
      {kind === "deliverable" && (
        <DeliverableRegisterForm
          projects={projects}
          deliverables={deliverables}
          actions={actions}
          presetProjectId={editors.deliverablePresetProjectId}
          timezone={timezone}
          onRegister={editors.registerDeliverable}
          onUpdate={editors.updateDeliverable}
          open
        />
      )}
      {kind === "action" && (
        <ActionEditor
          draft={editors.action}
          projects={projects}
          actions={actions}
          deliverables={deliverables}
          conditionDefinitions={conditionDefinitions}
          outcomes={outcomes}
          areas={areas}
          onChange={editors.setAction}
          onSubmit={editors.saveAction}
          onCancel={editors.close}
          open
        />
      )}
    </Sheet>
  );
}
