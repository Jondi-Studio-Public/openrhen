"use client";

import { isClosedStatus } from "@openrhen/contracts";
import { PlaceTabs } from "@/components/place-tabs";
import { useEffect } from "react";
import { useNow } from "@/shared/clock";
import { usePortal } from "@/state/portal-provider";
import { UNASSIGNED_AREA_ID, projectsForArea } from "@/features/plan/area-grouping";
import { usePlanEditors } from "@/features/plan/use-plan-editors";
import { cadenceDoneToday, recurrenceSummary } from "@/features/plan/plan-formatting";
import { assumedMark } from "@/features/plan/assumed-fields";
import { waitingOnMap } from "@/features/plan/prerequisite-choices";
import { ProjectForecastGrid } from "@/features/plan/components/project-forecast-grid";
import { ConnectionsFold } from "@/features/plan-map/components/connections-section";
import { PlanEditorSheets } from "@/features/plan/components/plan-editor-sheets";
import { AreaWorkLabel } from "@/features/plan/components/area-work-label";

/**
 * One area, whole: its outcomes, the projects that resolve to it (through their outcome, or through
 * the legacy `project.area` name), and — inside each project's own forecast card — its deliverables
 * and actions. This is where the old `/plan` page's full flat lists went: scoped to one area, they
 * stay short.
 *
 * `areaId === "unassigned"` is a reserved route for projects nothing else claims, plus the actions and
 * outcomes that point at nothing real at all: same page, minus the outcomes section an unassigned
 * bucket has no business owning. A real area is resolved first, so a real area that happened to be
 * given the reserved id would still be found rather than silently swallowed by the bucket.
 */
export function AreaDetail({ areaId }: { areaId: string }) {
  const { state, ready, forecasts, projectEnvelopes, capacityEnvelopes } = usePortal();
  const now = useNow("minute");
  // `#project-<id>` or `#outcome-<id>` names a card. The cards are drawn from state the browser loads
  // after the page, so the browser's own jump to the hash finds nothing: make it once they exist.
  useEffect(() => {
    if (!ready) return;
    const id = decodeURIComponent(window.location.hash.slice(1));
    const card = id ? document.getElementById(id) : null;
    if (!card) return;
    card.scrollIntoView({ block: "start" });
    card.focus({ preventScroll: true });
  }, [ready]);
  const detailedEndsAt = capacityEnvelopes?.find((envelope) => envelope.kind === "detailed")?.endsAt ?? null;
  const editors = usePlanEditors();
  const area = state.areas.find((item) => item.id === areaId);
  const isUnassigned = !area && areaId === UNASSIGNED_AREA_ID;

  if (!ready)
    return (
      <main className="content-page">
        <p>Loading the area…</p>
      </main>
    );

  if (!isUnassigned && !area) {
    return (
      <main className="content-page plan-page">
        <a className="back-link" href="/plan">
          ← Plan
        </a>
        <p className="eyebrow">Area</p>
        <h1>That area is not here.</h1>
        <p className="reason">
          It may have been removed, or belongs to a plan this browser has not loaded. <a href="/plan">Plan</a> lists the
          ones that are.
        </p>
      </main>
    );
  }

  const areaOutcomes = isUnassigned ? [] : state.outcomes.filter((outcome) => outcome.areaId === areaId);
  const areaProjects = projectsForArea(areaId, state.projects, state.outcomes, state.areas);
  const projectIds = new Set(areaProjects.map((project) => project.id));
  const areaDeliverables = state.deliverables.filter((item) => projectIds.has(item.projectId));
  // A dangling projectId or areaId is a different kind of orphan than "no area at all" — the record it
  // pointed at is simply gone — but the unassigned bucket is still the honest place to surface it.
  const orphanActions = isUnassigned
    ? state.actions.filter((action) => !state.projects.some((project) => project.id === action.projectId))
    : [];
  const orphanOutcomes = isUnassigned
    ? state.outcomes.filter((outcome) => !state.areas.some((item) => item.id === outcome.areaId))
    : [];

  return (
    <main className="content-page plan-page">
      <a className="back-link" href="/plan">
        ← Plan
      </a>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Area</p>
          <h1>{isUnassigned ? "Unassigned" : area!.name}</h1>
          <p className="reason">
            {isUnassigned ? "Projects nothing else claims." : area!.description || "No description yet"}
          </p>
          {!isUnassigned && <AreaWorkLabel areaId={areaId} />}
        </div>
        {!isUnassigned && (
          <button className="quiet small" onClick={() => editors.openEdit("area", area!)}>
            Edit area
          </button>
        )}
      </div>
      <PlaceTabs />

      {editors.openEditor === null && editors.error && (
        <p className="form-error" role="alert">
          {editors.error}
        </p>
      )}

      {!isUnassigned && (
        <section>
          <div className="section-heading">
            <h2>Outcomes</h2>
            <button className="quiet small" onClick={() => editors.openCreate("outcome", { areaId })}>
              New outcome
            </button>
          </div>
          <div className="hierarchy-list">
            {areaOutcomes.map((item) => (
              <article className="hierarchy-card" key={item.id} id={`outcome-${item.id}`} tabIndex={-1}>
                <div>
                  <p className="area-label">Outcome · value {item.value}/5</p>
                  <strong>{item.title}</strong>
                  <p>Done when: {item.definitionOfDone}</p>
                </div>
                <button className="quiet small" onClick={() => editors.openEdit("outcome", item)}>
                  Edit
                </button>
              </article>
            ))}
          </div>
          {!areaOutcomes.length && <p className="empty">No outcomes yet.</p>}
        </section>
      )}

      <section>
        <div className="section-heading">
          <h2>Projects</h2>
          <div className="actions flush">
            <button
              className="quiet small"
              onClick={() =>
                editors.openCreate("project", {
                  outcomeId: areaOutcomes.length === 1 ? areaOutcomes[0]!.id : undefined
                })
              }
            >
              New project
            </button>
            <button
              className="quiet small"
              onClick={() =>
                editors.openCreate("deliverable", {
                  projectId: areaProjects.length === 1 ? areaProjects[0]!.id : undefined
                })
              }
            >
              New deliverable
            </button>
            <button
              className="quiet small"
              onClick={() =>
                editors.openCreate("action", { projectId: areaProjects.length === 1 ? areaProjects[0]!.id : undefined })
              }
            >
              New action
            </button>
          </div>
        </div>
        {areaProjects.length ? (
          <ProjectForecastGrid
            projects={areaProjects}
            actions={state.actions}
            deliverables={areaDeliverables}
            activeSession={state.activeSession}
            forecasts={forecasts}
            projectEnvelopes={projectEnvelopes}
            detailedEndsAt={detailedEndsAt}
            timezone={state.settings.timezone}
            onEditProject={(item) => editors.openEdit("project", item)}
            onEditAction={(item) => editors.openEdit("action", item)}
            onEndRecurrenceGoal={editors.endRecurrenceGoal}
            onRecordCadenceCompletion={editors.recordCadenceCompletion}
            renderConnections={(type, id) => <ConnectionsFold itemType={type} itemId={id} />}
            waiting={waitingOnMap(state)}
          />
        ) : (
          <p className="empty">No projects here yet.</p>
        )}
      </section>

      {isUnassigned && (
        <section>
          <div className="section-heading">
            <h2>Orphan actions</h2>
          </div>
          {orphanActions.length ? (
            <article className="project-card">
              <ul>
                {orphanActions.map((itemAction) => (
                  <li className="action-row" key={itemAction.id}>
                    <div>
                      <span>{itemAction.title}</span>
                      <span>
                        {itemAction.remainingMinutes} min{assumedMark(itemAction, "remainingMinutes")} ·{" "}
                        {itemAction.energy}
                        {assumedMark(itemAction, "energy")}
                        {recurrenceSummary(itemAction, now)}
                      </span>
                    </div>
                    <div className="actions">
                      <button className="quiet small" onClick={() => editors.openEdit("action", itemAction)}>
                        Edit
                      </button>
                      {itemAction.schedulingMode === "cadence" &&
                        itemAction.recurrence &&
                        !itemAction.recurrence.completedAt &&
                        !(itemAction.status === "done" || isClosedStatus(itemAction.status)) &&
                        !cadenceDoneToday(itemAction, now) && (
                          <button className="quiet small" onClick={() => editors.recordCadenceCompletion(itemAction)}>
                            Done today
                          </button>
                        )}
                      {(itemAction.schedulingMode === "recurring" || itemAction.schedulingMode === "cadence") &&
                        itemAction.recurrence &&
                        itemAction.recurrence.completionMode !== "end_date" &&
                        !itemAction.recurrence.completedAt && (
                          <button className="quiet small" onClick={() => editors.endRecurrenceGoal(itemAction)}>
                            Mark goal complete
                          </button>
                        )}
                    </div>
                    <ConnectionsFold itemType="action" itemId={itemAction.id} />
                  </li>
                ))}
              </ul>
            </article>
          ) : (
            <p className="empty">No orphan actions.</p>
          )}
        </section>
      )}

      {isUnassigned && (
        <section>
          <div className="section-heading">
            <h2>Orphan outcomes</h2>
          </div>
          <div className="hierarchy-list">
            {orphanOutcomes.map((item) => (
              <article className="hierarchy-card" key={item.id} id={`outcome-${item.id}`} tabIndex={-1}>
                <div>
                  <p className="area-label">Outcome · value {item.value}/5</p>
                  <strong>{item.title}</strong>
                  <p>Done when: {item.definitionOfDone}</p>
                </div>
                <button className="quiet small" onClick={() => editors.openEdit("outcome", item)}>
                  Edit
                </button>
              </article>
            ))}
          </div>
          {!orphanOutcomes.length && <p className="empty">No orphan outcomes.</p>}
        </section>
      )}

      <PlanEditorSheets
        editors={editors}
        areas={state.areas}
        outcomes={state.outcomes}
        projects={state.projects}
        actions={state.actions}
        deliverables={state.deliverables}
        conditionDefinitions={state.conditionDefinitions}
        estimateBucketsMinutes={state.settings.estimateBucketsMinutes}
        timezone={state.settings.timezone}
      />
    </main>
  );
}
