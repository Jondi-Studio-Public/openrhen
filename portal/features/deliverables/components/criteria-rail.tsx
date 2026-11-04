"use client";

import type { StoredDeliverable, StoredDeliverableCriterion } from "@/state/portal-state";
import { label, newCriterion, replaceAt } from "@/features/deliverables/deliverable-model";
import type { EditDeliverable } from "./step-rail";

const criterionStates: StoredDeliverableCriterion["state"][] = [
  "unsatisfied",
  "satisfied",
  "uncertain",
  "not_applicable"
];
export const verificationMethods: NonNullable<StoredDeliverableCriterion["verificationMethod"]>[] = [
  "user_confirmation",
  "llm_inspection",
  "submission_receipt",
  "external_result",
  "not_verifiable"
];

/**
 * The completion contract. Every state the contract supports is offered — satisfied, unsatisfied,
 * uncertain, not applicable — along with the required flag, the evidence expected and how it will be
 * verified, so Review has something to compare against rather than a single tick.
 */
export function CriteriaRail({
  deliverable,
  editable,
  onEdit
}: {
  deliverable: StoredDeliverable;
  editable: boolean;
  onEdit: EditDeliverable;
}) {
  const setCriterion = (index: number, patch: Partial<StoredDeliverableCriterion>) =>
    onEdit((current) => ({
      ...current,
      criteria: replaceAt(current.criteria, index, { ...current.criteria[index]!, ...patch })
    }));
  const stepTitle = (id: string) => deliverable.steps.find((step) => step.id === id)?.title || "Untitled action";
  return (
    <section aria-label="Completion criteria">
      <div className="section-heading">
        <h2>Completion criteria</h2>
        <span>{deliverable.criteria.length}</span>
      </div>
      {deliverable.criteria.map((criterion, index) => (
        <details className="criterion-item" key={criterion.id}>
          <summary>
            <input
              aria-label={`${criterion.title || "Untitled criterion"} satisfied`}
              type="checkbox"
              checked={criterion.state === "satisfied"}
              disabled={!editable}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setCriterion(index, { state: event.target.checked ? "satisfied" : "unsatisfied" })}
            />
            <span>
              {criterion.title || "Untitled criterion"}
              <small>
                {" "}
                · {label(criterion.state)}
                {criterion.required ? "" : " · optional"}
              </small>
            </span>
          </summary>
          {editable ? (
            <div className="workspace-item-editor">
              <input
                aria-label="Criterion title"
                value={criterion.title}
                placeholder="What must be true when this is done?"
                onChange={(event) => setCriterion(index, { title: event.target.value })}
              />
              <label>
                State
                <select
                  value={criterion.state}
                  onChange={(event) => setCriterion(index, { state: event.target.value as never })}
                >
                  {criterionStates.map((value) => (
                    <option value={value} key={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="inline">
                <input
                  type="checkbox"
                  checked={criterion.required}
                  onChange={(event) => setCriterion(index, { required: event.target.checked })}
                />
                Required for completion
              </label>
              <label>
                Expected evidence
                <input
                  value={criterion.expectedEvidence ?? ""}
                  placeholder="What will show this is true?"
                  onChange={(event) => setCriterion(index, { expectedEvidence: event.target.value || undefined })}
                />
              </label>
              <label>
                Verification method
                <select
                  value={criterion.verificationMethod ?? ""}
                  onChange={(event) =>
                    setCriterion(index, {
                      verificationMethod: (event.target.value || undefined) as never
                    })
                  }
                >
                  <option value="">Not decided</option>
                  {verificationMethods.map((value) => (
                    <option value={value} key={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Made true by
                <select
                  multiple
                  value={criterion.stepIds}
                  onChange={(event) =>
                    setCriterion(index, {
                      stepIds: [...event.target.selectedOptions].map((option) => option.value)
                    })
                  }
                >
                  {deliverable.steps.map((step) => (
                    <option value={step.id} key={step.id}>
                      {step.title || "Untitled action"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Notes
                <input
                  value={criterion.notes ?? ""}
                  onChange={(event) => setCriterion(index, { notes: event.target.value || undefined })}
                />
              </label>
              <button
                type="button"
                className="quiet small danger"
                onClick={() =>
                  onEdit((current) => ({
                    ...current,
                    criteria: current.criteria.filter((item) => item.id !== criterion.id)
                  }))
                }
              >
                Remove criterion
              </button>
            </div>
          ) : (
            <div className="workspace-item-editor">
              {criterion.interpretation && <small>{criterion.interpretation}</small>}
              <small>
                {criterion.stepIds.length
                  ? `Made true by ${criterion.stepIds.map(stepTitle).join(", ")}`
                  : "No action makes this true yet"}
              </small>
              <small>
                Evidence: {criterion.expectedEvidence ?? "not stated"} · verified by{" "}
                {criterion.verificationMethod ? label(criterion.verificationMethod) : "an undecided method"}
              </small>
              {(criterion.sourceDocument || criterion.sourceLocation) && (
                <small>
                  Source: {criterion.sourceDocument ?? ""}
                  {criterion.sourceLocation ? ` · ${criterion.sourceLocation}` : ""}
                </small>
              )}
              {criterion.notes && <small>{criterion.notes}</small>}
            </div>
          )}
        </details>
      ))}
      {!deliverable.criteria.length && <p className="empty">No criteria yet.</p>}
      {editable && (
        <button
          type="button"
          className="quiet small"
          onClick={() =>
            onEdit((current) => ({
              ...current,
              criteria: [...current.criteria, newCriterion(current.criteria.length)]
            }))
          }
        >
          Add criterion
        </button>
      )}
    </section>
  );
}
