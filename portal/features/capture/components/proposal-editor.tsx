"use client";

import type { FormEvent, ReactNode } from "react";
import type { ResolvedQuestion } from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import flat from "@/components/ui/embedded.module.css";
import { QuestionField } from "@/features/capture/components/question-field";
import { placeOptions, placeTravelNote, withPlace } from "@/features/settings/context-summary";
import type { PlacementSuggestion } from "@/features/capture/placement-suggestion";
import type { ProposalDraft } from "@/features/capture/proposals";
import type { PortalState, ProposalType } from "@/state/portal-state";

/**
 * The classify-and-review form for one pending capture. The type is asked first because it decides
 * which fields follow; the markup is the Capture page's, unchanged, so a form that used to live
 * inside the review card can now also stand beside the list on a desk.
 */
export function ProposalEditor({
  state,
  draft,
  error,
  onDraftChange,
  onConfirm,
  onConfirmTentative,
  onCancel,
  questions = [],
  suggestion = null,
  answers = {},
  onAnswer,
  confirmLabel = "Confirm",
  fieldsHidden = false,
  typeChosenAbove = false,
  onShowFields,
  extraActions,
  embedded = false
}: {
  /** Sits inside another card (the Inbox's detail pane), so its note and actions take the flat look. */
  embedded?: boolean;
  state: Pick<PortalState, "areas" | "outcomes" | "projects" | "conditionDefinitions">;
  draft: ProposalDraft;
  error: string;
  onDraftChange: (draft: ProposalDraft) => void;
  onConfirm: () => void;
  /** Confirms a commitment as tentative, the "maybe" answer; offered only for a commitment. */
  onConfirmTentative?: () => void;
  /** Leaves the review; without it there is no Cancel (the Inbox's detail pane closes by moving on). */
  onCancel?: () => void;
  /** Open questions on this proposal; Confirm waits until every one has an answer. */
  questions?: ResolvedQuestion[];
  /** A project the placement add-on prefilled, with why; shown so the prefill is never silent. */
  suggestion?: PlacementSuggestion | null;
  answers?: Record<string, string>;
  onAnswer?: (field: string, value: string) => void;
  confirmLabel?: string;
  /**
   * Shows only the questions and the actions, with a "Change first" button that calls `onShowFields`,
   * for a proposal that can go as it is; the fields open when the person wants to change something.
   */
  fieldsHidden?: boolean;
  onShowFields?: () => void;
  /** The type is chosen by chips above the form, so the type select is not repeated. */
  typeChosenAbove?: boolean;
  /** Buttons placed after the editor's own (the Inbox's Ignore). */
  extraActions?: ReactNode;
}) {
  const unanswered = questions.some((question) => !answers[question.field]?.trim());
  const setDraft = onDraftChange;
  const places = placeOptions(state.conditionDefinitions, draft.locationId);
  const travelNote = placeTravelNote(places, draft.locationId);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConfirm();
  };
  return (
    <form className="proposal-editor" onSubmit={submit}>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {questions.length > 0 && (
        <div className="proposal-questions wide">
          {questions.map((question) => (
            <QuestionField
              key={question.field}
              idPrefix="proposal-question"
              question={question}
              value={answers[question.field] ?? ""}
              onChange={(value) => onAnswer?.(question.field, value)}
            />
          ))}
        </div>
      )}
      {suggestion && (
        <p className="placement-suggestion">
          Suggested project: <strong>{suggestion.projectTitle}</strong> ({suggestion.by}). {suggestion.reason} Change it
          below if it is wrong.
        </p>
      )}
      {!fieldsHidden && (
        <>
          {!typeChosenAbove && (
            <Field label="What should this become?">
              <select
                value={draft.proposalType}
                onChange={(event) => setDraft({ ...draft, proposalType: event.target.value as ProposalType })}
              >
                <option value="unclassified">Choose type</option>
                <option value="outcome">Outcome</option>
                <option value="project">Project</option>
                <option value="action">Action</option>
                <option value="deliverable">Deliverable</option>
                <option value="fixed_commitment">Fixed commitment</option>
                <option value="someday">Someday / maybe</option>
                <option value="reference">Reference</option>
              </select>
            </Field>
          )}
          <Field label="Corrected title" wide>
            <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
          </Field>
          {draft.proposalType === "outcome" && (
            <>
              <Field label="Area">
                <select value={draft.areaId} onChange={(event) => setDraft({ ...draft, areaId: event.target.value })}>
                  <option value="">Choose area</option>
                  {state.areas.map((area) => (
                    <option key={area.id} value={area.id}>
                      {area.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Value (1–5)">
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={draft.value}
                  onChange={(event) => setDraft({ ...draft, value: Number(event.target.value) })}
                />
              </Field>
              <Field label="Definition of done" wide>
                <input
                  value={draft.definitionOfDone}
                  onChange={(event) => setDraft({ ...draft, definitionOfDone: event.target.value })}
                />
              </Field>
              <Field label="Deadline">
                <input
                  type="datetime-local"
                  value={draft.externalDeadlineAt}
                  onChange={(event) => setDraft({ ...draft, externalDeadlineAt: event.target.value })}
                />
              </Field>
            </>
          )}
          {draft.proposalType === "project" && (
            <>
              <Field label="Outcome">
                <select
                  value={draft.outcomeId}
                  onChange={(event) => setDraft({ ...draft, outcomeId: event.target.value })}
                >
                  <option value="">Choose outcome</option>
                  {state.outcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>
                      {outcome.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Internal deadline">
                <input
                  type="datetime-local"
                  value={draft.internalDeadlineAt}
                  onChange={(event) => setDraft({ ...draft, internalDeadlineAt: event.target.value })}
                />
              </Field>
              <Field label="External deadline">
                <input
                  type="datetime-local"
                  value={draft.externalDeadlineAt}
                  onChange={(event) => setDraft({ ...draft, externalDeadlineAt: event.target.value })}
                />
              </Field>
            </>
          )}
          {draft.proposalType === "action" && (
            <>
              <Field label="Project">
                <select
                  value={draft.projectId}
                  onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
                >
                  <option value="">Choose project</option>
                  {state.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Expected minutes">
                <input
                  type="number"
                  min="1"
                  value={draft.expectedMinutes}
                  onChange={(event) => setDraft({ ...draft, expectedMinutes: Number(event.target.value) })}
                />
              </Field>
              <Field label="Pessimistic minutes">
                <input
                  type="number"
                  min="1"
                  value={draft.pessimisticMinutes}
                  onChange={(event) => setDraft({ ...draft, pessimisticMinutes: Number(event.target.value) })}
                />
              </Field>
              <Field label="Energy">
                <select
                  value={draft.energy}
                  onChange={(event) => setDraft({ ...draft, energy: event.target.value as ProposalDraft["energy"] })}
                >
                  <option value="high">High focus</option>
                  <option value="medium">Medium focus</option>
                  <option value="low">Low focus</option>
                  <option value="recovery">Recovery</option>
                </select>
              </Field>
              <Field label="Deadline">
                <input
                  type="datetime-local"
                  value={draft.externalDeadlineAt}
                  onChange={(event) => setDraft({ ...draft, externalDeadlineAt: event.target.value })}
                />
              </Field>
            </>
          )}
          {draft.proposalType === "deliverable" && (
            <>
              <Field label="Project">
                <select
                  value={draft.projectId}
                  onChange={(event) => setDraft({ ...draft, projectId: event.target.value })}
                >
                  <option value="">Choose project</option>
                  {state.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="External deadline">
                <input
                  type="datetime-local"
                  value={draft.externalDeadlineAt}
                  onChange={(event) => setDraft({ ...draft, externalDeadlineAt: event.target.value })}
                />
              </Field>
              <Field label="Internal deadline">
                <input
                  type="datetime-local"
                  value={draft.internalDeadlineAt}
                  onChange={(event) => setDraft({ ...draft, internalDeadlineAt: event.target.value })}
                />
              </Field>
              <Field label="Notes" wide>
                <input
                  value={draft.notes ?? ""}
                  onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
                />
              </Field>
            </>
          )}
          {draft.proposalType === "fixed_commitment" && (
            <>
              <Field label="Starts">
                <input
                  type="datetime-local"
                  value={draft.startsAt}
                  onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })}
                />
              </Field>
              <Field label="Ends">
                <input
                  type="datetime-local"
                  value={draft.endsAt}
                  onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })}
                />
              </Field>
              <Field label="Place">
                <select
                  value={draft.locationId}
                  onChange={(event) => setDraft(withPlace(draft, event.target.value, places))}
                >
                  <option value="">— none —</option>
                  {places.map((place) => (
                    <option key={place.id} value={place.id}>
                      {place.name}
                    </option>
                  ))}
                </select>
                {travelNote && <small>{travelNote}</small>}
              </Field>
              <Field label="Location">
                <input
                  value={draft.location}
                  onChange={(event) => setDraft({ ...draft, location: event.target.value })}
                />
              </Field>
            </>
          )}
          {(draft.proposalType === "someday" || draft.proposalType === "reference") && (
            <p className={embedded ? `${flat.note} ${flat.span}` : "proposal-note"}>
              This will remain stored with its original source, but it will not be offered as current work.
            </p>
          )}
        </>
      )}
      <div className={embedded ? `${flat.actions} ${flat.span}` : "form-actions"}>
        <Button
          type="submit"
          variant="primary"
          data-inbox-action="yes"
          disabled={unanswered}
          aria-describedby={unanswered ? "proposal-confirm-why" : undefined}
        >
          {confirmLabel}
        </Button>
        {draft.proposalType === "fixed_commitment" && onConfirmTentative && (
          <Button variant="secondary" disabled={unanswered} onClick={onConfirmTentative}>
            Confirm as tentative
          </Button>
        )}
        {fieldsHidden && onShowFields && (
          <Button variant="secondary" onClick={onShowFields}>
            Change first
          </Button>
        )}
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        {extraActions}
      </div>
      {unanswered && (
        <p className="microcopy" id="proposal-confirm-why">
          Answer the questions to confirm.
        </p>
      )}
    </form>
  );
}

function Field({ label, wide = false, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <label className={wide ? "field wide" : "field"}>
      <span>{label}</span>
      {children}
    </label>
  );
}
