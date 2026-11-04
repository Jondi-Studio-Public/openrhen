"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { PortalState } from "@/state/portal-state";
import { Button } from "@/components/ui/button";
import styles from "./overdue-proposals-panel.module.css";
import { projectPlanHref } from "@/features/plan/area-grouping";
import type { ClientForecast, ClientForecastIntervention } from "@/state/portal-provider";

const ACTION_LEVEL = new Set<string>(["split_work", "clarify_estimate"]);

/**
 * What to do about work that does not fit. An overdue project carries a proposal: its date has
 * passed, so the engine offers the earliest instant the remaining protected effort fits capacity
 * nobody has reserved. A live project that is behind or at risk carries its smallest useful
 * interventions, smallest first. All of them are proposals: the person acts in Plan; the
 * engine never applies one on its own.
 *
 * A low-visibility disclosure under Review's attention strip — the counts are Plan's job (each area
 * card already shows its own); this is only the proposal text. An overdue project can be marked "Seen, leave it"
 * (`onSeen`), which the page stores for the review week and then stops listing here. The date a card proposes can be
 * taken in place (`onAccept`, or `onMoveAll` for every card that has one, using the dates that fit together) when the missed date is the person's own:
 * a missed external date proposes a day after it, which an internal date may not be, so those cards, and any
 * with no date to take, open the editor over the review (`onEdit`).
 */
export function OverdueProposalsPanel({
  forecasts,
  state,
  onSeen,
  onAccept,
  onMoveAll,
  onEdit,
  busy = false
}: {
  forecasts: readonly ClientForecast[];
  state: PortalState;
  onSeen?: (projectId: string) => void;
  /** Moves the project's internal date to the one its card proposes. */
  onAccept?: (projectId: string, date: Date) => void;
  /** Moves every overdue project that has a proposed date. */
  onMoveAll?: (moves: { projectId: string; date: Date }[]) => void;
  /** Opens the project's editor in a sheet over the review. */
  onEdit?: (projectId: string) => void;
  busy?: boolean;
}) {
  const timezone = state.settings.timezone;
  const format = (date: Date) =>
    dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }).format(date);
  const titleOf = (projectId: string) => state.projects.find((item) => item.id === projectId)?.title ?? projectId;
  // Straight to the project's card; a forecast whose project is gone has nowhere better than Plan.
  const hrefOf = (projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    return project ? projectPlanHref(project, state.outcomes, state.areas) : "/plan";
  };
  const shortDate = (date: Date) =>
    dateTimeFormat(displayLocale(), { timeZone: timezone, day: "numeric", month: "short" }).format(date);
  const overdue = forecasts.filter((forecast) => forecast.overdue);
  // An internal date may not come after the external one, whoever missed which, so the proposed day can be taken
  // in place only when there is no external date or the day lands on or before it.
  const externalOf = (projectId: string) => state.projects.find((item) => item.id === projectId)?.externalDeadlineAt;
  const canTake = (forecast: ClientForecast) => {
    const proposal = forecast.proposal;
    if (!proposal?.earliestFeasibleAt) return false;
    const external = externalOf(forecast.projectId);
    return !external || proposal.earliestFeasibleAt.getTime() <= new Date(external).getTime();
  };
  // "Move all" saves the joint dates, which fit side by side; one card's own "Accept" keeps its solo date. A joint date
  // of null (or one past the external date) leaves that project out rather than saving a date that cannot hold.
  const movable = overdue.flatMap((forecast) => {
    if (!canTake(forecast)) return [];
    const { jointEarliestFeasibleAt, earliestFeasibleAt } = forecast.proposal!;
    const date = jointEarliestFeasibleAt === undefined ? earliestFeasibleAt! : jointEarliestFeasibleAt;
    if (!date) return [];
    const external = externalOf(forecast.projectId);
    return !external || date.getTime() <= new Date(external).getTime() ? [{ projectId: forecast.projectId, date }] : [];
  });
  const struggling = forecasts.filter((forecast) => !forecast.overdue && forecast.interventions?.length);
  const count = overdue.length + struggling.length;
  const describe = (forecast: ClientForecast, item: ClientForecastIntervention) => {
    const names = item.actionIds
      .map((id) => state.actions.find((action) => action.id === id)?.title)
      .filter((title): title is string => Boolean(title));
    const work = names.length ? names.join(", ") : "this work";
    const due = forecast.internalDeadlineAt ? ` before ${format(forecast.internalDeadlineAt)}` : "";
    switch (item.kind) {
      case "clarify_estimate":
        return `Narrow the estimate for ${work}. At its uncertain end it needs ${item.minutes} more minutes than fit.`;
      case "split_work":
        return `Let ${work} split across sessions, or shorten its minimum session. The time is there, but not in pieces long enough.`;
      case "add_time":
        return `Add ${item.minutes} minutes of suitable time${due}, or pause other work to free them.`;
      case "move_deadline":
        return item.proposedDeadlineAt
          ? `Or move the date to ${format(item.proposedDeadlineAt)}, the earliest the rest fits without displacing anything.`
          : "Or reduce the scope: the rest does not fit anywhere in the next six months.";
      case "request_extension":
        return item.proposedDeadlineAt
          ? `Or ask for an extension to ${format(item.proposedDeadlineAt)}, or hand ${item.minutes} minutes to someone else.`
          : `Or ask for an extension, or hand ${item.minutes} minutes to someone else: the rest does not fit in the next six months.`;
    }
  };
  return (
    <details className="editor-card">
      <summary>Proposals{count > 0 ? ` (${count})` : ""}</summary>
      <div className="editor-card-body">
        <p className="microcopy">
          A passed date is not recovered by working now. Move it, or mark the work done or paused. Work that does not
          fit its date gets the smallest change that would fix it.
        </p>
        {count ? (
          <>
            {onMoveAll && movable.length > 1 && (
              <Button size="sm" disabled={busy} onClick={() => onMoveAll(movable)}>
                Move all ({movable.length})
              </Button>
            )}
            {overdue.map((forecast) => {
              const proposal = forecast.proposal;
              return (
                <article className="row-card" key={forecast.projectId}>
                  <div>
                    <strong>{titleOf(forecast.projectId)}</strong>
                    <p>
                      {proposal
                        ? proposal.earliestFeasibleAt
                          ? `${proposal.deadlineOwner === "external" ? "Missed" : "Lapsed"} ${format(proposal.missedDeadlineAt)} (${proposal.deadlineOwner === "external" ? "external" : "self-set"}). Move the internal date to ${format(proposal.earliestFeasibleAt)}: that is the earliest the remaining effort fits in time not yet set aside.`
                          : `${proposal.deadlineOwner === "external" ? "Missed" : "Lapsed"} ${format(proposal.missedDeadlineAt)} (${proposal.deadlineOwner === "external" ? "external" : "self-set"}). The remaining effort does not fit anywhere in the next six months.`
                        : "The internal date has passed."}
                    </p>
                    {proposal?.reason && <p className="microcopy">{proposal.reason}</p>}
                    {proposal?.earliestFeasibleAt && !canTake(forecast) && (
                      <p className="microcopy">
                        Can&apos;t move past the external deadline
                        {externalOf(forecast.projectId)
                          ? ` (${shortDate(new Date(externalOf(forecast.projectId)!))})`
                          : ""}
                        . Edit the date instead.
                      </p>
                    )}
                  </div>
                  <span className={styles.actions}>
                    {onAccept && proposal?.earliestFeasibleAt && canTake(forecast) ? (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => onAccept(forecast.projectId, proposal.earliestFeasibleAt!)}
                      >
                        Accept {shortDate(proposal.earliestFeasibleAt)}
                      </Button>
                    ) : null}
                    {onEdit ? (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(forecast.projectId)}>
                        Edit the date
                      </Button>
                    ) : (
                      <a href={hrefOf(forecast.projectId)}>Move the date in Plan</a>
                    )}
                    {onSeen && (
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onSeen(forecast.projectId)}>
                        Seen, leave it
                      </Button>
                    )}
                  </span>
                </article>
              );
            })}
            {struggling.map((forecast) => (
              <article className="row-card" key={forecast.projectId}>
                <div>
                  <strong>{titleOf(forecast.projectId)}</strong>
                  <ul>
                    {forecast.interventions!.map((item) => (
                      <li key={item.kind}>{describe(forecast, item)}</li>
                    ))}
                  </ul>
                </div>
                {/* Estimates, splitting and session lengths belong to the actions, which the project editor cannot
                    change, so those proposals go to Plan; the project's own date and time open the Sheet. */}
                {onEdit &&
                !forecast.interventions!.some((item) => ACTION_LEVEL.has(item.kind) && item.actionIds.length) ? (
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => onEdit(forecast.projectId)}>
                    Change it
                  </Button>
                ) : (
                  <a href={hrefOf(forecast.projectId)}>Change it in Plan</a>
                )}
              </article>
            ))}
          </>
        ) : (
          // Only projects get proposals here; an overdue action is the week outlook's to list.
          <p className="empty">No project needs its date or plan changed.</p>
        )}
      </div>
    </details>
  );
}
