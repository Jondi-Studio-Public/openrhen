"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { cx } from "@/components/ui/cx";
import { useState } from "react";
import type { StoredAction, StoredArea, StoredOutcome, StoredProject } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { List, ListRow } from "@/components/ui/list-row";
import { Meter } from "@/components/ui/stat";
import { useNow } from "@/shared/clock";
import { UNASSIGNED_AREA_ID, partitionArchivedAreas, projectsForArea } from "@/features/plan/area-grouping";
import { displayHealth, isLapsedSelfSet } from "@/features/plan/plan-formatting";
import styles from "./area-overview.module.css";

/** Ranks a health reading worst-first, so an area with even one behind project reads as behind. */
const HEALTH_RANK: Record<string, number> = { behind: 0, at_risk: 1, on_track: 2, ahead: 3 };

const HEALTH_BADGE: Record<string, { tone: BadgeTone; text: string }> = {
  behind: { tone: "danger", text: "Behind" },
  at_risk: { tone: "warn", text: "At risk" },
  on_track: { tone: "accent", text: "On track" },
  ahead: { tone: "accent", text: "Ahead" },
  unknown: { tone: "neutral", text: "No forecast" }
};

const CLOSED_ACTION = new Set(["cancelled", "archived"]);

/**
 * `unknown` is not a verdict — it's the engine declining to forecast (no deadline, deadline beyond
 * the 180-day horizon, no estimates, dependency problems) — so it must not drag the whole area's
 * badge down to unknown just because one member project couldn't be forecast. Unknown members are
 * dropped from the rollup entirely; only when every member is unknown does the badge stay unknown.
 */
function worstHealth(forecasts: (ClientForecast | undefined)[]): { health: string | null; notForecast: number } {
  let worst: string | null = null;
  let notForecast = 0;
  for (const forecast of forecasts) {
    const health = displayHealth(forecast);
    if (health === "unknown") {
      notForecast += 1;
      continue;
    }
    if (worst === null || (HEALTH_RANK[health] ?? Infinity) < (HEALTH_RANK[worst] ?? Infinity)) worst = health;
  }
  return { health: worst ?? (notForecast > 0 ? "unknown" : null), notForecast: worst ? notForecast : 0 };
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * `/plan` itself: every area as one row of a list — sorted the way the planning hierarchy always
 * was, by `sortOrder` then name — linking through to `/plan/[areaId]`, where the area is edited. A
 * row reads as a verdict: the worst health among its projects as a badge, a meter of how much of its
 * work is done, and the next date it has to meet. Archived areas are not part of the plan any more,
 * so they wait behind a quiet toggle at the end rather than standing in the list looking like live
 * ones. A project whose area cannot be resolved at all still needs somewhere to be found, so it gets
 * one more row of its own.
 */
export function AreaOverview({
  areas,
  outcomes,
  projects,
  actions,
  forecasts,
  timezone
}: {
  areas: StoredArea[];
  outcomes: StoredOutcome[];
  projects: StoredProject[];
  actions: StoredAction[];
  forecasts: ClientForecast[];
  timezone: string;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { live, archived } = partitionArchivedAreas(areas);
  const unassignedCount = projectsForArea(UNASSIGNED_AREA_ID, projects, outcomes, areas).length;
  // The unassigned bucket also holds actions and outcomes that point at nothing real, not only
  // projects without an area — those need the door too, even when every project has a home.
  const orphanActionCount = actions.filter(
    (action) => !projects.some((project) => project.id === action.projectId)
  ).length;
  const orphanOutcomeCount = outcomes.filter((outcome) => !areas.some((area) => area.id === outcome.areaId)).length;
  const row = (area: StoredArea) => (
    <AreaRow
      key={area.id}
      area={area}
      outcomes={outcomes}
      projects={projects}
      actions={actions}
      areas={areas}
      forecasts={forecasts}
      timezone={timezone}
    />
  );

  return (
    <section className={styles.areas} aria-label="Areas">
      {live.length > 0 || unassignedCount > 0 || orphanActionCount > 0 || orphanOutcomeCount > 0 ? (
        <Card>
          <List>
            {live.map(row)}
            {(unassignedCount > 0 || orphanActionCount > 0 || orphanOutcomeCount > 0) && (
              <ListRow
                className={cx(styles.row)}
                href={`/plan/${UNASSIGNED_AREA_ID}`}
                title="Unassigned"
                meta={`${plural(unassignedCount, "project")} without an area`}
              />
            )}
          </List>
        </Card>
      ) : null}
      {!live.length && (
        <Card padded>
          <EmptyState
            title={archived.length ? "Every area is archived" : "No areas yet"}
            body={
              archived.length
                ? "Open one below to bring it back, or start a new one."
                : "An area is the top of the plan: outcomes, projects and actions live under it."
            }
          />
        </Card>
      )}
      {archived.length > 0 && (
        <>
          <button
            type="button"
            className={styles.archivedToggle}
            aria-expanded={showArchived}
            onClick={() => setShowArchived((open) => !open)}
          >
            {showArchived ? "Hide archived areas" : plural(archived.length, "archived area")}
          </button>
          {showArchived && (
            <Card aria-label="Archived areas">
              <List>{archived.map(row)}</List>
            </Card>
          )}
        </>
      )}
    </section>
  );
}

/** One area as one link: name and purpose, a meter of finished work with the next date, and its health. */
function AreaRow({
  area,
  outcomes,
  projects,
  actions,
  areas,
  forecasts,
  timezone
}: {
  area: StoredArea;
  outcomes: StoredOutcome[];
  projects: StoredProject[];
  actions: StoredAction[];
  areas: StoredArea[];
  forecasts: ClientForecast[];
  timezone: string;
}) {
  const areaProjects = projectsForArea(area.id, projects, outcomes, areas);
  const areaOutcomes = outcomes.filter((outcome) => outcome.areaId === area.id);
  const areaForecasts = areaProjects.map((project) => forecasts.find((item) => item.projectId === project.id));
  const overdueCount = areaForecasts.filter((forecast) => forecast?.overdue && !isLapsedSelfSet(forecast)).length;
  const lapsedCount = areaForecasts.filter((forecast) => isLapsedSelfSet(forecast)).length;
  const { health } = worstHealth(areaForecasts);
  const projectIds = new Set(areaProjects.map((project) => project.id));
  const work = actions.filter((action) => projectIds.has(action.projectId) && !CLOSED_ACTION.has(action.status));
  const done = work.filter((action) => action.status === "done").length;
  const now = useNow("minute").getTime();
  const nextDue = areaProjects
    .filter((project) => project.status === "active")
    .map((project) => project.externalDeadlineAt ?? project.internalDeadlineAt)
    .filter((due): due is string => Boolean(due) && new Date(due!).getTime() >= now)
    .sort()[0];
  const format = dateTimeFormat(displayLocale(), {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short"
  });
  const caption =
    overdueCount > 0
      ? `${overdueCount} overdue`
      : lapsedCount > 0
        ? `${plural(lapsedCount, "date")} lapsed`
        : nextDue
          ? `Next due ${format.format(new Date(nextDue))}`
          : areaProjects.some((project) => project.status === "active")
            ? "Needs a date to forecast"
            : areaProjects.length
              ? "Nothing active"
              : "No projects yet";
  const badge =
    overdueCount > 0 ? { tone: "danger" as const, text: "Overdue" } : health ? HEALTH_BADGE[health] : undefined;
  const archivedArea = area.status === "archived";
  return (
    <ListRow
      className={cx(styles.row)}
      href={`/plan/${area.id}`}
      title={<span className={styles.name}>{area.name}</span>}
      meta={
        <>
          <span className={styles.purpose}>
            {`${archivedArea ? "Archived · " : ""}${area.description || "No description yet"} · ${plural(areaOutcomes.length, "outcome")} · ${plural(areaProjects.length, "project")}`}
          </span>
          <span className={styles.phoneCaption}>{caption}</span>
        </>
      }
      trailing={
        <>
          <span className={styles.progress}>
            {work.length > 0 && (
              <Meter value={done / work.length} label={`${area.name}: ${done} of ${work.length} actions done`} />
            )}
            <span className={styles.caption}>{caption}</span>
          </span>
          {badge && (
            <Badge tone={badge.tone} className={styles.badge}>
              {badge.text}
            </Badge>
          )}
        </>
      }
    />
  );
}
