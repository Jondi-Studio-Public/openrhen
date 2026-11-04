"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useState } from "react";
import { useNow } from "@/shared/clock";
import { useMediaQuery } from "@/shared/use-media-query";
import type { ActiveSession, StoredDeliverable, StoredProject } from "@/state/portal-state";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { List, ListRow } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/stat";
import {
  CLOSED_DELIVERABLE_STATUSES,
  label,
  openBlockers,
  phaseLabel,
  phaseOf,
  sortDeliverables,
  statusText,
  stepProgress
} from "@/features/deliverables/deliverable-model";
import styles from "./deliverable-list.module.css";

const DAY_MS = 24 * 60 * 60 * 1000;

const deadlineOf = (item: StoredDeliverable) => item.externalDeadlineAt ?? item.internalDeadlineAt;

/**
 * The one sentence under the Plan header: how many deliverables are open and whether anything is
 * due (or overdue) this week. Closed work never counts.
 */
export function deliverablesAnswer(deliverables: StoredDeliverable[], now: number, timezone: string): string {
  const open = deliverables.filter((item) => !CLOSED_DELIVERABLE_STATUSES.has(item.status));
  if (!open.length) return "No open deliverables.";
  const weekday = dateTimeFormat(displayLocale(), { timeZone: timezone, weekday: "short" });
  const dated = open
    .flatMap((item) => {
      const due = deadlineOf(item);
      return due ? [{ item, at: new Date(due) }] : [];
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const next = dated[0];
  const count = `${open.length} ${open.length === 1 ? "deliverable" : "deliverables"} open`;
  if (!next) return `${count}; nothing is due this week.`;
  if (next.at.getTime() < now) return `${count}; ${next.item.title} is overdue.`;
  if (Math.ceil((next.at.getTime() - now) / DAY_MS) <= 7)
    return `${count}; ${next.item.title} is due ${weekday.format(next.at)}.`;
  return `${count}; nothing is due this week.`;
}

function Chevron() {
  return (
    <svg
      className={styles.chev}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="M6 3l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Every deliverable, whether or not it has been worked on, as rows in one card. Opening one shows
 * the workspace read-only; the timed, editable workspace is reached only by Start on an engine
 * recommendation from Now, and the deliverable in that session sorts first here.
 *
 * A row carries the facts the ranking runs on — the deadline, how far the actions have come, what is
 * blocking — so the list reads as "where everything stands" without opening anything. Finished
 * deliverables sit behind a toggle under the card rather than among the live ones.
 */
export function DeliverableList({
  deliverables,
  projects,
  activeSession,
  timezone,
  onOpen
}: {
  deliverables: StoredDeliverable[];
  projects: StoredProject[];
  activeSession: ActiveSession | null;
  timezone: string;
  onOpen: (deliverable: StoredDeliverable) => void;
}) {
  const format = dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "medium" });
  const ordered = sortDeliverables(deliverables, activeSession);
  const now = useNow("minute").getTime();
  const phone = useMediaQuery("(max-width: 719px)");
  const [showFinished, setShowFinished] = useState(false);

  if (!ordered.length)
    return (
      <Card>
        <EmptyState
          title="No deliverables yet"
          body="Register one in Plan. When the planner recommends it, Start from Now opens its workspace."
        />
      </Card>
    );

  const row = (item: StoredDeliverable) => {
    const inSession = activeSession?.targetType === "deliverable" && activeSession.targetId === item.id;
    const progress = stepProgress(item);
    const blockers = openBlockers(item).length;
    const closed = CLOSED_DELIVERABLE_STATUSES.has(item.status);
    const due = deadlineOf(item);
    const dueAt = due ? new Date(due) : null;
    const daysLeft = dueAt ? Math.ceil((dueAt.getTime() - now) / DAY_MS) : null;
    const overdue = !closed && dueAt !== null && dueAt.getTime() < now;
    const soon = !closed && !overdue && daysLeft !== null && daysLeft <= 7;
    const caption = closed
      ? null
      : dueAt
        ? overdue
          ? `Overdue · was due ${format.format(dueAt)}`
          : `Due ${format.format(dueAt)}${item.externalDeadlineAt ? "" : " (self-set)"}`
        : "No deadline";
    const needsReview = item.steps.some((step) => step.estimateNeedsReview);
    const project = projects.find((candidate) => candidate.id === item.projectId)?.title ?? "Unknown project";
    const tone: BadgeTone = inSession ? "accent" : closed ? "neutral" : overdue ? "danger" : soon ? "warn" : "neutral";
    const badge = inSession ? "In session" : closed ? label(item.status) : phaseLabel(phaseOf(item));
    const flags = [
      blockers > 0 ? `${blockers} open ${blockers === 1 ? "blocker" : "blockers"}` : null,
      needsReview ? "estimate needs review" : null
    ].filter(Boolean);
    const meta = [
      project,
      statusText(item),
      progress.total
        ? `${progress.done} of ${progress.total} ${progress.total === 1 ? "action" : "actions"} done`
        : "no actions yet",
      progress.remaining ? `${progress.remaining} min remaining` : null,
      inSession ? "Open session" : null,
      phone ? caption : null
    ].filter(Boolean);
    return (
      <ListRow
        key={item.id}
        title={<span className={styles.titleText}>{item.title}</span>}
        meta={
          <>
            <span className={styles.meta}>{meta.join(" · ")}</span>
            {flags.length > 0 && <span className={`${styles.meta} ${styles.flags}`}>{flags.join(" · ")}</span>}
          </>
        }
        trailing={
          <span className={styles.trail}>
            {!phone && progress.total > 0 && !closed && (
              <span className={styles.progress}>
                <Meter
                  value={progress.done / progress.total}
                  label={`${progress.done} of ${progress.total} actions done`}
                />
                {caption && <span className={`${styles.caption} ${overdue ? styles.overdue : ""}`}>{caption}</span>}
              </span>
            )}
            {!phone && (progress.total === 0 || closed) && caption && (
              <span className={styles.progress}>
                <span className={`${styles.caption} ${overdue ? styles.overdue : ""}`}>{caption}</span>
              </span>
            )}
            <span className={styles.badgeSlot}>
              <Badge tone={tone}>{badge}</Badge>
            </span>
            <Chevron />
          </span>
        }
        onClick={() => onOpen(item)}
      />
    );
  };

  const live = ordered.filter((item) => !CLOSED_DELIVERABLE_STATUSES.has(item.status));
  const finished = ordered.filter((item) => CLOSED_DELIVERABLE_STATUSES.has(item.status));
  return (
    <div className={styles.list}>
      {live.length > 0 && (
        <Card as="section" aria-label="Deliverables" className={styles.group}>
          <List>{live.map(row)}</List>
        </Card>
      )}
      {finished.length > 0 && (
        <>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={showFinished}
            onClick={() => setShowFinished((current) => !current)}
          >
            {showFinished
              ? "Hide finished deliverables"
              : `${finished.length} finished ${finished.length === 1 ? "deliverable" : "deliverables"}`}
          </button>
          {showFinished && (
            <Card as="section" aria-label="Finished deliverables" className={styles.group}>
              <List>{finished.map(row)}</List>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
