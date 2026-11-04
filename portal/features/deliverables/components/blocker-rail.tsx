"use client";

import type { StoredDeliverable, StoredDeliverableBlocker } from "@/state/portal-state";
import { label, newBlocker, OPEN_BLOCKER_STATES, replaceAt } from "@/features/deliverables/deliverable-model";
import type { EditDeliverable } from "./step-rail";

const blockerStates: StoredDeliverableBlocker["state"][] = [
  "open",
  "awaiting_response",
  "possibly_resolved",
  "resolved",
  "dismissed"
];
const blockerCategories: StoredDeliverableBlocker["category"][] = [
  "missing_information",
  "waiting_on_someone",
  "prerequisite",
  "tool_or_context_unavailable",
  "technical_problem",
  "energy_or_health",
  "other"
];

/**
 * What is in the way, and of which steps. A blocker's scope is what makes partial blocking real:
 * a blocker that names no step blocks nothing, and one that names some steps leaves the rest offered.
 */
export function BlockerRail({
  deliverable,
  editable,
  onEdit
}: {
  deliverable: StoredDeliverable;
  editable: boolean;
  onEdit: EditDeliverable;
}) {
  const setBlocker = (index: number, patch: Partial<StoredDeliverableBlocker>) =>
    onEdit((current) => ({
      ...current,
      blockers: replaceAt(current.blockers, index, { ...current.blockers[index]!, ...patch })
    }));
  const stepTitle = (id: string) => deliverable.steps.find((step) => step.id === id)?.title || "Untitled action";
  const open = deliverable.blockers.filter((blocker) => OPEN_BLOCKER_STATES.has(blocker.state)).length;
  return (
    <section aria-label="Blockers">
      <div className="section-heading">
        <h2>Blockers</h2>
        <span>{open}</span>
      </div>
      {deliverable.blockers.map((blocker, index) => (
        <details className="blocker-line" key={blocker.id}>
          <summary>
            <span>{blocker.description || "Unnamed blocker"}</span>
            <small>
              {" "}
              · {label(blocker.state)} ·{" "}
              {blocker.stepIds.length
                ? `blocks ${blocker.stepIds.length} action${blocker.stepIds.length === 1 ? "" : "s"}`
                : "blocks nothing yet"}
            </small>
          </summary>
          {editable ? (
            <div className="workspace-item-editor">
              <input
                aria-label="Blocker description"
                value={blocker.description}
                placeholder="What is in the way?"
                onChange={(event) => setBlocker(index, { description: event.target.value })}
              />
              <label>
                Category
                <select
                  value={blocker.category}
                  onChange={(event) => setBlocker(index, { category: event.target.value as never })}
                >
                  {blockerCategories.map((value) => (
                    <option value={value} key={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                State
                <select
                  value={blocker.state}
                  onChange={(event) =>
                    setBlocker(index, {
                      state: event.target.value as never,
                      resolvedAt:
                        event.target.value === "resolved" ? (blocker.resolvedAt ?? new Date().toISOString()) : undefined
                    })
                  }
                >
                  {blockerStates.map((value) => (
                    <option value={value} key={value}>
                      {label(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Cannot be done until this clears
                <select
                  multiple
                  value={blocker.stepIds}
                  onChange={(event) =>
                    setBlocker(index, {
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
                Proposed resolution
                <input
                  value={blocker.proposedResolution ?? ""}
                  onChange={(event) => setBlocker(index, { proposedResolution: event.target.value || undefined })}
                />
              </label>
              <label>
                Resolution notes
                <input
                  value={blocker.resolutionNotes ?? ""}
                  onChange={(event) => setBlocker(index, { resolutionNotes: event.target.value || undefined })}
                />
              </label>
              <button
                type="button"
                className="quiet small danger"
                onClick={() =>
                  onEdit((current) => ({
                    ...current,
                    blockers: current.blockers.filter((item) => item.id !== blocker.id)
                  }))
                }
              >
                Remove blocker
              </button>
            </div>
          ) : (
            <div className="workspace-item-editor">
              <small>{label(blocker.category)}</small>
              <small>
                {blocker.stepIds.length ? `Blocks ${blocker.stepIds.map(stepTitle).join(", ")}` : "Blocks no action"}
              </small>
              {blocker.proposedResolution && <small>Proposed: {blocker.proposedResolution}</small>}
              {blocker.resolutionNotes && <small>Resolution: {blocker.resolutionNotes}</small>}
            </div>
          )}
        </details>
      ))}
      {!deliverable.blockers.length && <p className="empty">No blockers recorded.</p>}
      {editable && (
        <button
          type="button"
          className="quiet small"
          onClick={() => onEdit((current) => ({ ...current, blockers: [...current.blockers, newBlocker()] }))}
        >
          Record blocker
        </button>
      )}
    </section>
  );
}
