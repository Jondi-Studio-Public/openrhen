"use client";

import type { ReactNode } from "react";
import type { ActiveSession, StoredAction, StoredDeliverable, StoredProject } from "@/state/portal-state";
import type { ClientForecast, ClientProjectEnvelope } from "@/state/portal-provider";
import type { UnmetPrerequisite } from "@openrhen/contracts";
import { ProjectForecastCard } from "@/features/plan/components/project-forecast-card";

/** Cancelled and archived actions are gone from the plan: not counted, not listed (done ones are listed). */
const CLOSED_ACTION_STATUSES: readonly string[] = ["done", "cancelled", "archived"];

/**
 * Every project beside its forecast. Finished actions are left out of the forecast math — they cannot
 * change it — but still get to the card, as a separate `doneActions` list, so a mistakenly-completed
 * one can be found and reopened. Deliverables are matched to their project the same way and carried
 * through unfiltered by status, so a card can tell a closed one from a live one.
 */
export function ProjectForecastGrid({
  projects,
  actions,
  deliverables = [],
  activeSession = null,
  forecasts,
  projectEnvelopes,
  detailedEndsAt = null,
  timezone,
  onEditProject,
  onEditAction,
  onEndRecurrenceGoal,
  onRecordCadenceCompletion,
  renderConnections,
  waiting,
  now
}: {
  projects: StoredProject[];
  actions: StoredAction[];
  deliverables?: StoredDeliverable[];
  activeSession?: ActiveSession | null;
  forecasts: ClientForecast[];
  projectEnvelopes: ClientProjectEnvelope[];
  /** The "detailed" capacity envelope's own `endsAt`, threaded to every card's `latestSafeStartText`. */
  detailedEndsAt?: Date | null;
  timezone: string;
  onEditProject: (project: StoredProject) => void;
  onEditAction?: (action: StoredAction) => void;
  onEndRecurrenceGoal?: (action: StoredAction) => void;
  onRecordCadenceCompletion?: (action: StoredAction) => void;
  renderConnections?: (type: "project" | "action", id: string) => ReactNode;
  /** What each project, deliverable and action still waits on (`waitingOnMap`). */
  waiting?: Map<string, UnmetPrerequisite[]>;
  now?: Date;
}) {
  return (
    <section className="project-grid">
      {projects.map((item) => (
        <ProjectForecastCard
          key={item.id}
          project={item}
          forecast={forecasts.find((candidate) => candidate.projectId === item.id)}
          actions={actions.filter(
            (candidate) => candidate.projectId === item.id && !CLOSED_ACTION_STATUSES.includes(candidate.status)
          )}
          doneActions={actions.filter((candidate) => candidate.projectId === item.id && candidate.status === "done")}
          deliverables={deliverables.filter((candidate) => candidate.projectId === item.id)}
          activeSession={activeSession}
          envelopes={projectEnvelopes.filter((envelope) => envelope.projectId === item.id)}
          detailedEndsAt={detailedEndsAt}
          timezone={timezone}
          onEdit={onEditProject}
          onEditAction={onEditAction}
          onEndRecurrenceGoal={onEndRecurrenceGoal}
          onRecordCadenceCompletion={onRecordCadenceCompletion}
          renderConnections={renderConnections}
          {...(waiting ? { waiting } : {})}
          {...(now ? { now } : {})}
        />
      ))}
    </section>
  );
}
