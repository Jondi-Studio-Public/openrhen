"use client";

import { formatShortDate } from "@/shared/date-format";
import type { ReactNode } from "react";
import { useNow } from "@/shared/clock";
import type { ActiveSession, StoredAction, StoredDeliverable, StoredProject } from "@/state/portal-state";
import type { ClientForecast, ClientProjectEnvelope } from "@/state/portal-provider";
import {
  bandLabel,
  cadenceDoneToday,
  formatMinutes,
  healthChipClass,
  healthChipText,
  localiseReason,
  recurrenceSummary
} from "@/features/plan/plan-formatting";
import { CLOSED_DELIVERABLE_STATUSES, label, phaseOf, stepProgress } from "@/features/deliverables/deliverable-model";
import type { UnmetPrerequisite } from "@openrhen/contracts";
import { waitingOn, waitingText } from "@/features/plan/prerequisite-choices";
import { latestSafeStartText } from "@/features/plan/latest-safe-start";
import { hoursText } from "@/features/plan/components/time-ahead";
import { assumedMark } from "@/features/plan/assumed-fields";

/**
 * One project with the arithmetic behind its health: what is left, what capacity is compatible with
 * it, what earlier deadlines have already taken, and the pace that is left over. Its deliverables and
 * actions sit behind a disclosure so a long-running project does not push everything below it down
 * the page. A deliverable row never expands in place — it is a door, not a drawer: its steps live in
 * the deliverable's own workspace, so the row just links there. Standalone actions (which have no
 * deliverable of their own) keep the row-level edit / "done today" / "mark goal complete" affordances
 * the old flat action list offered, grouped under their own nested "Actions" disclosure once there is
 * something else on the project to sit beside.
 */
export function ProjectForecastCard({
  project,
  forecast,
  actions,
  doneActions = [],
  deliverables = [],
  activeSession = null,
  envelopes,
  detailedEndsAt = null,
  timezone,
  onEdit,
  onEditAction,
  onEndRecurrenceGoal,
  onRecordCadenceCompletion,
  renderConnections,
  waiting,
  now: nowProp
}: {
  project: StoredProject;
  forecast: ClientForecast | undefined;
  actions: StoredAction[];
  /** Finished actions of this project: shown at the end of the disclosure, marked done, still editable. */
  doneActions?: StoredAction[];
  /** This project's deliverables, each its own enterable row rather than a sub-disclosure. */
  deliverables?: StoredDeliverable[];
  activeSession?: ActiveSession | null;
  envelopes: ClientProjectEnvelope[];
  /** The "detailed" capacity envelope's own `endsAt`, for `latestSafeStartText` (null when there is none). */
  detailedEndsAt?: Date | null;
  timezone: string;
  onEdit: (project: StoredProject) => void;
  onEditAction?: ((action: StoredAction) => void) | undefined;
  onEndRecurrenceGoal?: ((action: StoredAction) => void) | undefined;
  onRecordCadenceCompletion?: ((action: StoredAction) => void) | undefined;
  /** A collapsed Connections row for a project or action; the page supplies it. */
  renderConnections?: ((type: "project" | "action", id: string) => ReactNode) | undefined;
  /** What each project, deliverable and action still waits on, keyed `kind:id` (`waitingOnMap`). */
  waiting?: Map<string, UnmetPrerequisite[]> | undefined;
  now?: Date | undefined;
}) {
  const clock = useNow("minute");
  const now = nowProp ?? clock;
  const waitingLine = (kind: "project" | "deliverable" | "action", id: string) =>
    waiting ? waitingText(waitingOn(waiting, kind, id)) : "";
  // The math stays over the non-done `actions` prop only; `doneActions` is display-only.
  const actionMinutes = actions.reduce((sum, current) => sum + current.remainingMinutes, 0);
  const actionRow = (itemAction: StoredAction, done: boolean) => {
    const safeStart = latestSafeStartText({
      forecast,
      unitId: itemAction.id,
      detailedEndsAt,
      timeZone: timezone,
      now
    });
    return (
      <li className="action-row" key={itemAction.id}>
        <div>
          <span>{itemAction.title}</span>
          <span>
            {done ? "done · " : ""}
            {itemAction.remainingMinutes} min{assumedMark(itemAction, "remainingMinutes")} · {itemAction.energy} focus
            {assumedMark(itemAction, "energy")}
            {safeStart.kind !== "none" ? ` · ${safeStart.kind === "exact" ? "latest " : ""}${safeStart.text}` : ""}
            {recurrenceSummary(itemAction, now)}
            {!done && waitingLine("action", itemAction.id) ? ` · ${waitingLine("action", itemAction.id)}` : ""}
          </span>
        </div>
        <div className="actions">
          {onEditAction && (
            <button className="quiet small" onClick={() => onEditAction(itemAction)}>
              Edit
            </button>
          )}
          {itemAction.schedulingMode === "cadence" &&
            itemAction.recurrence &&
            !itemAction.recurrence.completedAt &&
            onRecordCadenceCompletion &&
            !["done", "cancelled", "archived"].includes(itemAction.status) &&
            !cadenceDoneToday(itemAction, now) && (
              <button className="quiet small" onClick={() => onRecordCadenceCompletion(itemAction)}>
                Done today
              </button>
            )}
          {(itemAction.schedulingMode === "recurring" || itemAction.schedulingMode === "cadence") &&
            itemAction.recurrence &&
            itemAction.recurrence.completionMode !== "end_date" &&
            !itemAction.recurrence.completedAt &&
            onEndRecurrenceGoal && (
              <button className="quiet small" onClick={() => onEndRecurrenceGoal(itemAction)}>
                Mark goal complete
              </button>
            )}
        </div>
        {renderConnections?.("action", itemAction.id)}
      </li>
    );
  };
  const deliverableRow = (item: StoredDeliverable) => {
    const inSession = activeSession?.targetType === "deliverable" && activeSession.targetId === item.id;
    const closed = CLOSED_DELIVERABLE_STATUSES.has(item.status);
    const progress = stepProgress(item);
    const due = item.externalDeadlineAt ?? item.internalDeadlineAt;
    return (
      <li className="action-row deliverable-row" key={item.id}>
        <a href={`/deliverables?deliverable=${encodeURIComponent(item.id)}`}>
          <div>
            <span>{item.title}</span>
            <span>
              {progress.total ? `${progress.done}/${progress.total} steps` : "no steps yet"}
              {due ? ` · due ${formatShortDate(due, timezone, now)}` : " · no deadline"}
              {!closed && waitingLine("deliverable", item.id) ? ` · ${waitingLine("deliverable", item.id)}` : ""}
            </span>
          </div>
          <span className="deliverable-row-status">
            <span className={`phase-pill${inSession ? " live" : ""}${closed ? " closed" : ""}`}>
              {inSession ? "In session" : closed ? label(item.status) : phaseOf(item)}
            </span>
            <span className="deliverable-row-enter" aria-hidden="true">
              ›
            </span>
          </span>
        </a>
      </li>
    );
  };
  const hasDeliverables = deliverables.length > 0;
  const hasActions = actions.length > 0 || doneActions.length > 0;
  const actionRows = (
    <>
      {actions.map((itemAction) => actionRow(itemAction, false))}
      {doneActions.map((itemAction) => actionRow(itemAction, true))}
    </>
  );
  return (
    // The id is the card's address from elsewhere (Review's "Review in Plan"); -1 lets that jump focus it.
    <article className="project-card" id={`project-${project.id}`} tabIndex={-1}>
      <div className="project-top">
        <div>
          <p className="area-label">{project.area}</p>
          <h2>{project.title}</h2>
        </div>
        <span className={healthChipClass(forecast)}>
          {healthChipText(forecast)}
          {forecast?.confidence ? ` · ${forecast.confidence.replace("_", " ")} confidence` : ""}
        </span>
      </div>
      {project.actualCompletionRatio !== undefined && project.requiredCompletionRatio !== undefined && (
        <p className="pace-evidence forecast-label">
          {`${Math.round(project.actualCompletionRatio * 100)}% done · ${Math.round(project.requiredCompletionRatio * 100)}% of time used`}
        </p>
      )}
      <p className="microcopy">
        {forecast?.healthBasis === "adherence"
          ? "Maintenance project · health tracks whether you keep up with it, not a deadline"
          : forecast?.internalDeadlineAt
            ? `Deadline ${formatShortDate(forecast.internalDeadlineAt, timezone, now)}`
            : "No deadline set"}
        {forecast?.forecastBand ? ` · ${bandLabel(forecast.forecastBand)}` : ""}
      </p>
      {forecast?.healthBasis === "adherence" && forecast.adherence && (
        <ul className="adherence-actions">
          {forecast.adherence.actions.map((detail) => {
            const title = actions.find((item) => item.id === detail.actionId)?.title ?? detail.actionId;
            return (
              <li className="forecast-label" key={detail.actionId}>
                {title}: {detail.done} of {detail.expectedSoFar} due {detail.periodLabel} (target {detail.target})
              </li>
            );
          })}
        </ul>
      )}
      {waitingLine("project", project.id) && (
        <p className="forecast-label">Project is {waitingLine("project", project.id)}.</p>
      )}
      {project.remainingEffortOverrideMinutes !== undefined && (
        <div className="override-evidence">
          <strong>Manual project override: {formatMinutes(project.remainingEffortOverrideMinutes)}</strong>
          <span>Current action estimates: {formatMinutes(actionMinutes)}. The override is authoritative.</span>
        </div>
      )}
      <div className="project-math">
        {(
          [
            [
              "Minutes of work still to do, including a safety margin in case estimates run over.",
              forecast?.protectedRemainingMinutes,
              "of work left"
            ],
            [
              "Free time before the deadline that suits this work, before projects due sooner take their share.",
              forecast?.grossCompatibleCapacityMinutes,
              "free before deadline"
            ],
            [
              "Free time already set aside for projects due sooner.",
              forecast?.reservedByEarlierDeadlinesMinutes,
              "for earlier deadlines"
            ],
            [
              "Free time still open to this project once projects due sooner have taken theirs.",
              forecast?.compatibleCapacityMinutes,
              "left for this"
            ],
            [
              "Time a week you would need to spend on this to finish by the deadline.",
              forecast?.requiredPaceMinutesPerWeek,
              "a week needed"
            ],
            [
              "Time set aside for this project after the first week, in the rougher later bands of Plan's Time ahead.",
              envelopes.reduce((sum, envelope) => sum + envelope.reservedMinutes, 0),
              "set aside later"
            ]
          ] as const
        )
          // A figure the forecast has no answer for (no deadline, say) is left out rather than shown as a dash.
          .filter(([, minutes]) => minutes != null)
          .map(([title, minutes, text]) => (
            <span key={text} title={title}>
              {minutes! < 60 ? `${Math.round(minutes!)} min` : hoursText(minutes!)}
              <small>{text}</small>
            </span>
          ))}
      </div>
      {!envelopes.length && forecast?.health !== "unknown" && (
        <p className="forecast-label">
          Nothing set aside after week one: its time is booked at exact times in the first 7 days.
        </p>
      )}
      {forecast?.reasons.some((reason) => reason.includes("outside the current")) && (
        <p className="forecast-label">Beyond the six months planned.</p>
      )}
      {hasDeliverables ? (
        <details className="project-actions">
          <summary>
            {deliverables.length} deliverable{deliverables.length === 1 ? "" : "s"}
            {hasActions ? ` · ${actions.length} action${actions.length === 1 ? "" : "s"}` : ""}
          </summary>
          <ul>
            {deliverables.map((item) => deliverableRow(item))}
            {hasActions && (
              <li className="nested-disclosure-row">
                <details className="project-actions">
                  <summary>Actions ({actions.length})</summary>
                  <ul>{actionRows}</ul>
                </details>
              </li>
            )}
          </ul>
        </details>
      ) : (
        hasActions && (
          <details className="project-actions">
            <summary>Actions ({actions.length})</summary>
            <ul>{actionRows}</ul>
          </details>
        )
      )}
      {forecast?.reasons.length ? (
        <details className="project-reasons">
          <summary>Forecast evidence</summary>
          {forecast.reasons.map((reason) => (
            <p key={reason}>{localiseReason(reason, timezone)}</p>
          ))}
        </details>
      ) : null}
      {renderConnections?.("project", project.id)}
      <button className="quiet small" onClick={() => onEdit(project)}>
        Edit project
      </button>
    </article>
  );
}
