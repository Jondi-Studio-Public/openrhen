"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useRef } from "react";
import type { StoredDeliverable } from "@/state/portal-state";
import { useModalFocus } from "@/shared/use-modal-focus";

/**
 * The closure a completed deliverable earns: what was satisfied, what its completion unlocked, and
 * where to go next. Shown as a celebration overlay at the moment of completion, and as the
 * workspace's standing body whenever a closed deliverable is reopened — completing is an ending,
 * not a return to the Carry out rails.
 */
export function CompletionPanel({
  deliverable,
  projectTitle,
  unlocked,
  timezone,
  overlay,
  onDismiss,
  onBack
}: {
  deliverable: StoredDeliverable;
  projectTitle: string | undefined;
  /** Deliverables that were waiting on this one and now have every prerequisite complete. */
  unlocked: StoredDeliverable[];
  timezone: string;
  /** True renders the celebratory dialog; false renders the same facts as the page body. */
  overlay: boolean;
  onDismiss?: () => void;
  onBack: () => void;
}) {
  const overlayRef = useRef<HTMLDivElement>(null);
  // The overlay had no keyboard escape route at all: no Escape, no focus trap, no restore. `onDismiss`
  // is its actual close action ("Stay here"); on the rare instance where a caller renders the overlay
  // without one, Escape falls back to `onBack` ("All deliverables") as the nearest thing to a close.
  const { onKeyDown } = useModalFocus({ active: overlay, trapRef: overlayRef, onClose: onDismiss ?? onBack });
  const format = dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "long", timeStyle: "short" });
  const satisfied = deliverable.criteria.filter((item) => item.state === "satisfied").length;
  const stepsDone = deliverable.steps.filter((item) => item.status === "done").length;
  const cancelled = deliverable.status !== "completed";
  const body = (
    <section className={`completion-panel${overlay ? " celebrating" : ""}`} aria-label="Deliverable completed">
      <p className="completion-mark" aria-hidden="true">
        {cancelled ? "◼" : "✓"}
      </p>
      <p className="eyebrow">{cancelled ? deliverable.status.replace("_", " ") : "Completed"}</p>
      <h2>{deliverable.title}</h2>
      {projectTitle && <p className="completion-project">{projectTitle}</p>}
      {deliverable.completedAt && <p className="completion-date">{format.format(new Date(deliverable.completedAt))}</p>}
      {!cancelled && (
        <p className="completion-facts">
          {satisfied}/{deliverable.criteria.length} criteria satisfied
          {deliverable.steps.length ? ` · ${stepsDone}/${deliverable.steps.length} steps done` : ""}
        </p>
      )}
      {unlocked.length > 0 && (
        <div className="completion-unlocked">
          <p>Completing this unlocked:</p>
          <ul>
            {unlocked.map((item) => (
              <li key={item.id}>{item.title}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="actions completion-actions">
        <a className="button-link" href="/">
          See what's next on Now
        </a>
        <button type="button" className="quiet" onClick={onBack}>
          All deliverables
        </button>
        {overlay && onDismiss && (
          <button type="button" className="quiet" onClick={onDismiss}>
            Stay here
          </button>
        )}
      </div>
    </section>
  );
  if (!overlay) return body;
  return (
    <div
      ref={overlayRef}
      className="completion-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Deliverable completed"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {body}
    </div>
  );
}
