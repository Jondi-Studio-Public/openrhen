"use client";

import type { ReactNode } from "react";
import type { DeliverableReadiness, RequirementPathway } from "@openrhen/contracts";
import type {
  ActiveSession,
  PortalState,
  StoredDeliverable,
  StoredDeliverableContractProposal,
  StoredProject
} from "@/state/portal-state";
import type { ClientContinuation } from "@/state/portal-provider";
import { Sheet } from "@/components/sheet";
import { DeliverableDetails } from "./deliverable-details";
import { StepRail, type EditDeliverable } from "./step-rail";
import { CriteriaRail } from "./criteria-rail";
import { SourcePanel, type SourceAttachment } from "./source-panel";
import { BlockerRail } from "./blocker-rail";
import { ReadinessPanel, type EngineOpinion } from "./readiness-panel";
import { SessionCard, type SessionOutcome } from "./session-card";
import { ProposalCard } from "./proposal-card";
import type { WorkspaceDrawer } from "./phase-bar";

const TITLES: Record<WorkspaceDrawer, string> = {
  details: "Details",
  steps: "Actions",
  criteria: "Completion criteria",
  sources: "Retained source files",
  blockers: "Blockers",
  readiness: "Readiness",
  session: "Session",
  proposals: "Earlier bulk extraction"
};

const EDITING_DRAWERS = new Set<WorkspaceDrawer>(["details", "steps", "criteria", "blockers"]);

/**
 * Every rail that used to sit permanently beside the conversation, now one at a time behind the phase
 * bar's chips. Only the open panel is constructed — `drawer` picks which, `null` renders nothing — so
 * the workspace pays for at most one rail's worth of DOM. Details, Steps, Criteria and Blockers carry
 * the page's draft state, so each gets its own save row rather than relying on the action bar below.
 */
export function WorkspaceSheets({
  drawer,
  connections,
  onClose,
  deliverable,
  readiness,
  engine,
  conditionDefinitions,
  projects,
  others,
  timezone,
  editable,
  dirty,
  saving,
  onSaveStepRequirementPathways,
  session,
  now,
  currentStepTitle,
  canSwitch,
  planningDecisionCurrent,
  continuation,
  proposals,
  proposalDrafts,
  onEdit,
  onSave,
  onSwitchStep,
  onAttach,
  onPauseResume,
  onContinue,
  onFinish,
  onProposalChange,
  onDecideProposal
}: {
  drawer: WorkspaceDrawer | null;
  /** The deliverable's Connections section, shown under Details. */
  connections?: ReactNode;
  onClose: () => void;
  deliverable: StoredDeliverable;
  readiness: DeliverableReadiness;
  engine: EngineOpinion | null | undefined;
  conditionDefinitions: PortalState["conditionDefinitions"];
  projects: StoredProject[];
  others: StoredDeliverable[];
  timezone: string;
  editable: boolean;
  dirty: boolean;
  saving: boolean;
  onSaveStepRequirementPathways: (stepId: string, pathways: RequirementPathway[]) => Promise<boolean> | boolean;
  session: ActiveSession | null;
  now: Date;
  currentStepTitle: string | undefined;
  canSwitch: boolean;
  planningDecisionCurrent: boolean;
  continuation: ClientContinuation | null;
  proposals: StoredDeliverableContractProposal[];
  proposalDrafts: Record<string, StoredDeliverableContractProposal>;
  onEdit: EditDeliverable;
  onSave: () => void;
  onSwitchStep: (stepId: string) => void;
  onAttach: (request: SourceAttachment) => Promise<void>;
  onPauseResume: () => void;
  onContinue: () => void;
  onFinish: (outcome: SessionOutcome, note: string, endedAt?: string) => void;
  onProposalChange: (
    proposal: StoredDeliverableContractProposal,
    change: Partial<StoredDeliverableContractProposal>
  ) => void;
  onDecideProposal: (proposal: StoredDeliverableContractProposal, decision: "confirm" | "ignore") => void;
}) {
  return (
    <Sheet open={drawer !== null} onClose={onClose} title={drawer ? TITLES[drawer] : ""} className="deliverable-sheet">
      <div className="workspace-rail sheet-rail">
        {drawer === "details" && (
          <DeliverableDetails
            deliverable={deliverable}
            others={others}
            projects={projects}
            timezone={timezone}
            editable={editable}
            onEdit={onEdit}
            connections={connections}
          />
        )}
        {drawer === "steps" && (
          <StepRail
            deliverable={deliverable}
            readiness={readiness}
            conditionDefinitions={conditionDefinitions}
            editable={editable}
            currentStepId={session?.stepId}
            stepSeconds={session?.stepSeconds}
            canSwitch={canSwitch}
            onSwitchStep={(stepId) => {
              onSwitchStep(stepId);
              onClose();
            }}
            onEdit={onEdit}
            timezone={timezone}
            onSaveStepRequirementPathways={onSaveStepRequirementPathways}
            savingRequirementPathways={saving}
          />
        )}
        {drawer === "criteria" && <CriteriaRail deliverable={deliverable} editable={editable} onEdit={onEdit} />}
        {drawer === "sources" && (
          <SourcePanel deliverable={deliverable} editable={editable} disabled={dirty || saving} onAttach={onAttach} />
        )}
        {drawer === "blockers" && <BlockerRail deliverable={deliverable} editable={editable} onEdit={onEdit} />}
        {drawer === "readiness" && (
          <ReadinessPanel deliverable={deliverable} readiness={readiness} engine={engine} timezone={timezone} />
        )}
        {drawer === "session" &&
          (session ? (
            <SessionCard
              session={session}
              now={now}
              currentStepTitle={currentStepTitle}
              saving={saving}
              planningDecisionCurrent={planningDecisionCurrent}
              continuation={continuation}
              timezone={timezone}
              onPauseResume={onPauseResume}
              onContinue={onContinue}
              onFinish={onFinish}
            />
          ) : (
            <p className="empty">No active session.</p>
          ))}
        {drawer === "proposals" &&
          proposals.map((proposal) => (
            <ProposalCard
              key={proposal.id}
              proposal={proposal}
              draft={proposalDrafts[proposal.id] ?? proposal}
              editable={editable}
              busy={dirty || saving}
              onChange={(change) => onProposalChange(proposal, change)}
              onDecide={(decision) => onDecideProposal(proposal, decision)}
            />
          ))}
        {drawer &&
          EDITING_DRAWERS.has(drawer) &&
          (editable ? (
            <div className="sheet-save-row">
              <span>{dirty ? "Unsaved changes" : "Saved"}</span>
              <button type="button" disabled={!dirty || saving} onClick={onSave}>
                Save changes
              </button>
            </div>
          ) : (
            // A read-only view has no draft, so nothing here could ever enable Save: offer the way out.
            <div className="sheet-save-row">
              <button type="button" className="quiet" onClick={onClose}>
                Close
              </button>
            </div>
          ))}
      </div>
    </Sheet>
  );
}
