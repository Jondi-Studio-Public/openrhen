"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useEffect, useState } from "react";
import type { PortalState } from "@/state/portal-state";
import { areaBalance, AREA_BALANCE_WINDOW_DAYS } from "@/features/review/area-balance";
import { periodFor } from "@/features/review/planning-focus-period";
import { resolveProjectAreaId } from "@/features/plan/area-grouping";

type Recorded = { projectId: string; minutes: number }[];

const hours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;

/**
 * The blueprint's monthly direction check (§9), folded like the week outlook: area balance over the
 * last four weeks with neglected areas flagged (a signal only), the active outcomes to
 * re-judge, the capacity assumption plans run on, and paused work that may need a new state. Saving
 * this month's focus on `/review/focus` is what closes it, so the "due" chip reads the stored monthly
 * focus rather than a second record of its own.
 */
export function MonthlyCheckPanel({ state, now, folded = true }: { state: PortalState; now: Date; folded?: boolean }) {
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/review/area-time")
      .then((response) => (response.ok ? (response.json() as Promise<{ projects: Recorded }>) : null))
      .then((payload) => {
        if (cancelled) return;
        if (payload) setRecorded(payload.projects);
        else setFailed(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const timezone = state.settings.timezone;
  const month = periodFor("monthly", now, timezone);
  const monthName = dateTimeFormat(displayLocale(), { timeZone: "UTC", month: "long" }).format(
    new Date(`${month.start}T00:00:00Z`)
  );
  const done = state.planningFocus.some((item) => item.kind === "monthly" && item.periodStart === month.start);
  const rows = areaBalance(state, recorded ?? []).map((row) => ({
    ...row,
    neglected: recorded ? row.neglected : false
  }));
  const neglected = rows.filter((row) => row.neglected).length;
  const totalMinutes = rows.reduce((sum, row) => sum + row.recordedMinutes, 0);
  const areaName = (areaId: string) => state.areas.find((area) => area.id === areaId)?.name ?? "No area";
  const outcomes = state.outcomes.filter((outcome) => outcome.status === "active");
  const pausedOutcomes = state.outcomes.filter((outcome) => outcome.status === "paused");
  const pausedProjects = state.projects.filter((project) => project.status === "paused");

  const body = (
    <div className="editor-card-body">
      <h3>Area balance · last {AREA_BALANCE_WINDOW_DAYS / 7} weeks</h3>
      {failed && <p className="form-warning">Recorded time could not be read, so no area is flagged as neglected.</p>}
      {rows.length ? (
        rows.map((row) => (
          <article className="row-card" key={row.areaId}>
            <div>
              <strong>{row.name}</strong>
              <p>
                {recorded ? `${hours(row.recordedMinutes)} recorded · ${Math.round(row.share * 100)}%` : "…"} ·{" "}
                {row.activeOutcomes} active {row.activeOutcomes === 1 ? "outcome" : "outcomes"} · {row.activeProjects}{" "}
                active {row.activeProjects === 1 ? "project" : "projects"}
              </p>
            </div>
            {row.neglected && <span className="health at_risk">neglected</span>}
          </article>
        ))
      ) : (
        <p className="empty">No active areas.</p>
      )}
      <p className="microcopy">A signal for deciding focus, not a ranking input.</p>

      <h3>Do these outcomes still matter?</h3>
      {outcomes.length ? (
        <ul className="monthly-check-list">
          {outcomes.map((outcome) => (
            <li key={outcome.id}>
              {outcome.title} <span className="microcopy">· {areaName(outcome.areaId)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No active outcomes.</p>
      )}

      <h3>Is capacity realistic?</h3>
      <p className="microcopy">
        Plans treat {Math.round(state.settings.defaultUsableFraction * 100)}% of free time as usable
        {recorded ? `; ${hours(totalMinutes)} of project work was recorded in the last four weeks` : ""}.{" "}
        <a href="/settings/planning">Adjust in Settings</a>
      </p>

      <h3>Paused work</h3>
      {pausedOutcomes.length + pausedProjects.length ? (
        <ul className="monthly-check-list">
          {pausedOutcomes.map((outcome) => (
            <li key={outcome.id}>
              {outcome.title} <span className="microcopy">· outcome</span>
            </li>
          ))}
          {pausedProjects.map((project) => (
            <li key={project.id}>
              {project.title}{" "}
              <span className="microcopy">
                · {areaName(resolveProjectAreaId(project, state.outcomes, state.areas))}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">Nothing is paused.</p>
      )}
      <p className="microcopy">
        Resume, close or leave each one paused in <a href="/plan">Plan</a>.
      </p>

      <p className={done ? "microcopy" : "form-warning"}>
        {done ? `${monthName}'s focus is chosen. ` : `Finish by choosing ${monthName}'s focus. `}
        <a href="/review/focus">{done ? "Change focus" : "Choose focus"}</a>
      </p>
    </div>
  );
  // In a sheet the panel is the whole content, so it drops its own fold.
  if (!folded) return body;
  return (
    <details className="editor-card monthly-check">
      <summary>
        Monthly check · {monthName}
        {/* The chips are spans with only a CSS margin between them; the hidden commas keep a screen reader from running "October" into "due". */}
        {!done && (
          <>
            <span className="visually-hidden">, </span>
            <span className="flag-chip review">due</span>
          </>
        )}
        {neglected > 0 && (
          <>
            <span className="visually-hidden">, </span>
            <span className="flag-chip review">{neglected} neglected</span>
          </>
        )}
      </summary>
      {body}
    </details>
  );
}
