"use client";

import { useState } from "react";
import type { RequirementPathway } from "@openrhen/contracts";
import type { PortalState, StoredDeliverableStep } from "@/state/portal-state";
import { Sheet } from "@/components/sheet";
import { RequirementPathways } from "./requirement-pathways";

/**
 * The one way to set a step's context requirements without opening a session. The read-only
 * workspace (a deliverable viewed from the list, outside an engine-allocated session) offers no
 * editing at all — by design, work happens only inside a session — but a requirement pathway
 * is the one field a person needs to set *before* a session exists: the engine will not offer a
 * session on a step it cannot place, and a step it cannot place is exactly the case a wrong or
 * missing pathway causes. Until this popup, only the CLI and deliverable chat could reach it.
 *
 * Saves immediately on its own, independent of the workspace's draft/dirty/Save flow — there is no
 * draft to be dirty outside a session — through the same save_entity/deliverable command the
 * session-editable rail and the CLI both use, so the engine picks up the change on its next plan run.
 */
export function StepRequirementsSheet({
  open,
  step,
  conditionDefinitions,
  saving,
  onSave,
  onClose
}: {
  open: boolean;
  step: StoredDeliverableStep;
  conditionDefinitions: PortalState["conditionDefinitions"];
  saving: boolean;
  onSave: (pathways: RequirementPathway[]) => Promise<boolean> | boolean;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RequirementPathway[]>(step.requirementPathways);
  // Reset the draft to the step's saved pathways on the rising edge of `open`, the same pattern
  // `Sheet` itself uses for its animation phase — so reopening always starts from what is actually
  // saved rather than whatever was left over from a cancelled edit.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setDraft(step.requirementPathways);
  }

  return (
    <Sheet open={open} onClose={onClose} title={`Where can "${step.title || "this action"}" be done?`}>
      <RequirementPathways pathways={draft} conditionDefinitions={conditionDefinitions} editable onChange={setDraft} />
      <div className="form-actions">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            void Promise.resolve(onSave(draft)).then((saved) => {
              if (saved) onClose();
            });
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" className="quiet" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
