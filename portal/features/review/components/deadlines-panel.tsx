"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { PortalState } from "@/state/portal-state";
import type { ClientDeadlineOutlook, ClientDeadlineProject, ClientDeadlineVerdict } from "@/state/portal-provider";

const VERDICT_ORDER: ClientDeadlineVerdict[] = ["overdue", "behind", "tight", "ok"];
const VERDICT_LABEL: Record<ClientDeadlineVerdict, string> = {
  overdue: "past its deadline",
  behind: "behind",
  tight: "tight",
  ok: "on plan"
};
/** The existing `.health` chip colours: overdue and behind are red, at risk amber, on track green. */
const VERDICT_CLASS: Record<ClientDeadlineVerdict, string> = {
  overdue: "overdue",
  behind: "behind",
  tight: "at_risk",
  ok: "on_track"
};

const NO_OUTCOME = "none";

/** "1 h 30 min short" or "2 h to spare", from the expected margin. */
function slackText(minutes: number | null): string {
  if (minutes === null) return "slack unknown";
  const abs = Math.abs(Math.round(minutes));
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const span = hours ? (rest ? `${hours} h ${rest} min` : `${hours} h`) : `${rest} min`;
  return minutes < 0 ? `${span} short` : `${span} to spare`;
}

/** Overdue first, then smallest slack (most negative) first, unknown slack last, then title. */
function bySlack(a: ClientDeadlineProject, b: ClientDeadlineProject): number {
  const overdue = Number(b.verdict === "overdue") - Number(a.verdict === "overdue");
  if (overdue) return overdue;
  const slackA = a.slackMinutes ?? Number.POSITIVE_INFINITY;
  const slackB = b.slackMinutes ?? Number.POSITIVE_INFINITY;
  if (slackA !== slackB) return slackA < slackB ? -1 : 1;
  return (a.title ?? a.projectId).localeCompare(b.title ?? b.projectId);
}

/**
 * Every project the engine gave a deadline verdict, sorted by slack and grouped by outcome, with the
 * deadline, how short or spare the expected work is, the latest safe start and the one-line
 * suggestion. A view only: nothing here changes the plan. Tight and on-plan rows are listed too, so
 * the list shows what is close as well as what has slipped.
 */
export function DeadlinesPanel({ outlook, state }: { outlook: ClientDeadlineOutlook | null; state: PortalState }) {
  const timezone = state.settings.timezone;
  const when = (date: Date | null) =>
    date
      ? dateTimeFormat(displayLocale(), {
          timeZone: timezone,
          weekday: "short",
          day: "numeric",
          month: "short",
          hour: "numeric",
          minute: "2-digit"
        }).format(date)
      : null;
  if (!outlook || outlook.projects.length === 0) {
    return (
      <div className="editor-card-body">
        <p className="empty">
          No project with a deadline is being tracked. A plan made before deadlines were tracked shows nothing here
          until the plan is next recalculated; add a deadline to a project and it will appear after the next
          recalculation.
        </p>
      </div>
    );
  }

  const projectTitle = (row: ClientDeadlineProject) =>
    row.title ?? state.projects.find((item) => item.id === row.projectId)?.title ?? "Untitled project";
  const groups = new Map<string, ClientDeadlineProject[]>();
  for (const row of [...outlook.projects].sort(bySlack)) {
    const key = row.outcomeId ?? NO_OUTCOME;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const outcomeRows = new Map(outlook.outcomes.map((row) => [row.outcomeId, row]));
  // Groups in the order of their worst row: an outcome with something overdue first, then the least slack.
  const ordered = [...groups.entries()].sort(([, a], [, b]) => bySlack(a[0]!, b[0]!));
  const counts = VERDICT_ORDER.map((verdict) => ({
    verdict,
    count: outlook.projects.filter((row) => row.verdict === verdict).length
  })).filter((entry) => entry.count > 0);

  return (
    <div className="editor-card-body">
      <p className="microcopy">
        {counts.map((entry) => `${entry.count} ${VERDICT_LABEL[entry.verdict]}`).join(" · ")}. Sorted by how little
        slack is left; this list only shows the plan and changes nothing.
      </p>
      {ordered.map(([key, rows]) => {
        const outcome = key === NO_OUTCOME ? undefined : outcomeRows.get(key);
        const heading =
          key === NO_OUTCOME
            ? "No outcome"
            : (outcome?.title ?? state.outcomes.find((item) => item.id === key)?.title ?? "Outcome");
        return (
          <section key={key} aria-label={heading}>
            <h3>
              {heading}
              {outcome && (
                <span className={`health ${VERDICT_CLASS[outcome.verdict]}`}>{VERDICT_LABEL[outcome.verdict]}</span>
              )}
            </h3>
            {rows.map((row) => {
              const deadline = when(row.deadlineAt);
              const start = when(row.latestSafeStart);
              return (
                <article className="row-card" key={row.projectId}>
                  <div>
                    <strong>{projectTitle(row)}</strong>
                    <p>
                      {deadline ? `Deadline ${deadline}` : "No deadline date"} · {slackText(row.slackMinutes)}
                      {start ? ` · latest safe start ${start}` : ""}
                      {row.verdict === "overdue" && row.earliestFeasibleAt !== undefined
                        ? row.earliestFeasibleAt
                          ? ` · would fit by ${when(row.earliestFeasibleAt)}`
                          : " · does not fit inside the forecast horizon"
                        : ""}
                    </p>
                    {row.suggestion && <p className="microcopy">{row.suggestion}</p>}
                  </div>
                  <span className={`health ${VERDICT_CLASS[row.verdict]}`}>{VERDICT_LABEL[row.verdict]}</span>
                </article>
              );
            })}
          </section>
        );
      })}
    </div>
  );
}
