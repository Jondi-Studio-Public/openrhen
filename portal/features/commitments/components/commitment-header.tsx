"use client";

import type { ReactNode } from "react";
import type { StoredCommitment, StoredProject } from "@/state/portal-state";
import { formatZonedDateTime, formatZonedTime } from "@/shared/date-format";

/**
 * What this commitment is, when it runs, and what it belongs to. The date is stated once and the
 * end time alone after it, because a commitment that crosses midnight is rare and a repeated date
 * buries the times it sits between.
 */
export function CommitmentHeader({
  commitment,
  project,
  timezone,
  actions
}: {
  commitment: StoredCommitment;
  project: StoredProject | undefined;
  timezone: string;
  /** Edit and other controls, kept out of this component so the page decides what it offers. */
  actions?: ReactNode;
}) {
  return (
    <header className="page-heading commitment-heading">
      <div>
        <p className="eyebrow">Fixed commitment</p>
        <h1>{commitment.title}</h1>
        <p className="reason">
          {formatZonedDateTime(commitment.startsAt, timezone)}–{formatZonedTime(commitment.endsAt, timezone)} ·{" "}
          {commitment.status}
          {commitment.setupBeforeMinutes || commitment.transitionAfterMinutes
            ? ` · ${commitment.setupBeforeMinutes}m before / ${commitment.transitionAfterMinutes}m after`
            : ""}
        </p>
        {/* Plan has no per-project anchor, so the link goes to the page that holds them rather than
            to a fragment that would land nowhere. */}
        {project && (
          <p className="microcopy">
            Project: <a href="/plan">{project.title}</a>
          </p>
        )}
      </div>
      {actions && <div className="row-actions">{actions}</div>}
    </header>
  );
}
