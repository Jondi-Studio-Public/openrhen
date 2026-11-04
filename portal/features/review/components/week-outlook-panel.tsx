"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { PortalState } from "@/state/portal-state";
import type { ClientWeekOutlook } from "@/state/portal-provider";

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;

/**
 * The engine's read of the coming week: what the detailed band reserves for each project against
 * the weekly pace its deadline requires, and where the reserved minutes land by area. Area minutes
 * are a stewardship signal for the person reviewing — never a ranking term.
 *
 * A folded `<details>` rather than an always-open section: the aggregate reserved/free figure this
 * used to print lives on Plan's Time ahead card now (its "Next 7 days" line), so this only
 * needs to earn attention when something is under-paced.
 */
export function WeekOutlookPanel({
  outlook,
  state,
  folded = true
}: {
  outlook: ClientWeekOutlook | null;
  state: PortalState;
  folded?: boolean;
}) {
  const timezone = state.settings.timezone;
  const dates = outlook ? `${formatDate(outlook.startsAt, timezone)} – ${formatDate(outlook.endsAt, timezone)}` : null;
  const projectTitle = (id: string) => state.projects.find((item) => item.id === id)?.title ?? id;
  const areaTitle = (id: string) => state.areas.find((item) => item.id === id)?.name ?? id;
  const actionTitle = (id: string) => state.actions.find((item) => item.id === id)?.title ?? id;
  const underPaced = new Set(outlook?.underPacedProjectIds ?? []);
  const projects = [...(outlook?.projects ?? [])].sort(
    (a, b) =>
      Number(underPaced.has(b.projectId)) - Number(underPaced.has(a.projectId)) || b.reservedMinutes - a.reservedMinutes
  );
  const body = (
    <div className="editor-card-body">
      {!outlook ? (
        <p className="empty">The current plan was made before a week outlook was available.</p>
      ) : (
        <>
          {projects.length ? (
            projects.map((project) => (
              <article className="row-card" key={project.projectId}>
                <div>
                  <strong>{projectTitle(project.projectId)}</strong>
                  <p>
                    {hours(project.reservedMinutes)} set aside
                    {project.requiredPaceMinutesPerWeek !== null
                      ? ` · needs ${hours(project.requiredPaceMinutesPerWeek)} a week`
                      : " · no dated pace"}
                    {underPaced.has(project.projectId) ? ` · short by ${hours(project.paceShortfallMinutes)}` : ""}
                  </p>
                </div>
                <span className={`health ${project.health}`}>
                  {underPaced.has(project.projectId) ? "short on time" : project.health.replace("_", " ")}
                </span>
              </article>
            ))
          ) : (
            <p className="empty">Nothing is set aside this week.</p>
          )}
          {outlook.areas.length > 0 && (
            <p className="microcopy">
              By area:{" "}
              {outlook.areas.map((entry) => `${areaTitle(entry.areaId)} ${hours(entry.reservedMinutes)}`).join(" · ")}.
              A signal for stewardship, not a ranking input.
            </p>
          )}
          {outlook.cadence && (
            <p className="microcopy">
              A cadence wants about {hours(outlook.cadence.demandMinutesPerWeek)} a week from free time, not set aside —
              about {hours(outlook.cadence.softReservedMinutes ?? 0)} of that fits this week's free time.
              {outlook.cadence.due.length
                ? ` Due now: ${outlook.cadence.due
                    .map((entry) =>
                      entry.daysOverdue > 0
                        ? `${actionTitle(entry.actionId)} (${entry.daysOverdue} ${entry.daysOverdue === 1 ? "day" : "days"} overdue)`
                        : `${actionTitle(entry.actionId)} (today)`
                    )
                    .join(", ")}.`
                : " Nothing is overdue."}
            </p>
          )}
        </>
      )}
      <p className="microcopy">
        The next 7 days' free hours are on <a href="/plan">Plan’s Time ahead</a>.
      </p>
    </div>
  );
  // In a sheet the panel is the whole content, so it drops its own fold.
  if (!folded) return body;
  return (
    <details className="editor-card">
      <summary>
        Week outlook{dates ? ` · ${dates}` : ""}
        {underPaced.size > 0 && <span className="flag-chip review">{underPaced.size} short on time</span>}
      </summary>
      {body}
    </details>
  );
}

function formatDate(date: Date, timeZone: string) {
  return dateTimeFormat(displayLocale(), { timeZone, day: "numeric", month: "short" }).format(date);
}
