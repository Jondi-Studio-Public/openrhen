"use client";

import { dateTimeFormat, displayLocale } from "@/shared/locale";
import type { ReactNode } from "react";
import type { StoredDeliverable, StoredProject } from "@/state/portal-state";
import { dateInput, dateValue } from "@/features/plan/plan-formatting";
import type { EditDeliverable } from "./step-rail";

/**
 * The deliverable's own planning facts — the deadlines, uncertainty and weight the engine ranks it
 * by, and the deliverables that must finish first. Registration in Plan captures a shell; this is
 * where the shell is completed, because a deliverable with no deadline never wins the ranking and the
 * person had no way to say when it was due.
 */
export function DeliverableDetails({
  deliverable,
  others,
  projects,
  timezone,
  editable,
  onEdit,
  connections = null
}: {
  deliverable: StoredDeliverable;
  others: StoredDeliverable[];
  projects: StoredProject[];
  timezone: string;
  editable: boolean;
  onEdit: EditDeliverable;
  /** The deliverable's Connections section, supplied by the page. */
  connections?: ReactNode;
}) {
  const format = dateTimeFormat(displayLocale(), { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  const prerequisites = others.filter((item) => item.id !== deliverable.id);
  const title = (id: string) => others.find((item) => item.id === id)?.title ?? id;
  const selected = prerequisites.filter((item) => deliverable.dependencyIds.includes(item.id));
  // The unselected rest, grouped by project — the deliverable's own project first, since a
  // prerequisite is most often a sibling — each group folded behind its own summary so seventeen
  // candidates do not stand as seventeen rows.
  const projectTitle = (id: string) => projects.find((item) => item.id === id)?.title ?? "Other work";
  const groups = [...new Set(prerequisites.map((item) => item.projectId))]
    .sort((a, b) =>
      a === deliverable.projectId
        ? -1
        : b === deliverable.projectId
          ? 1
          : projectTitle(a).localeCompare(projectTitle(b))
    )
    .map((projectId) => ({
      projectId,
      title: projectTitle(projectId),
      items: prerequisites.filter(
        (item) => item.projectId === projectId && !deliverable.dependencyIds.includes(item.id)
      )
    }))
    .filter((group) => group.items.length > 0);
  const toggle = (id: string, checked: boolean) =>
    onEdit((current) => ({
      ...current,
      dependencyIds: checked ? [...current.dependencyIds, id] : current.dependencyIds.filter((other) => other !== id)
    }));
  const option = (item: StoredDeliverable, isSelected: boolean) => (
    <label className={`prerequisite-option${isSelected ? " selected" : ""}`} key={item.id}>
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(event) => {
          // Read before the updater runs: by then the controlled input has re-rendered.
          const checked = event.target.checked;
          toggle(item.id, checked);
        }}
      />
      <span>{item.title}</span>
    </label>
  );
  const refTitle = (ref: { kind: string; id: string }) =>
    ref.kind === "project"
      ? `project ${projects.find((item) => item.id === ref.id)?.title ?? ref.id}`
      : ref.kind === "deliverable"
        ? title(ref.id)
        : "an action";
  const set = (change: Partial<StoredDeliverable>) => onEdit((current) => ({ ...current, ...change }));
  if (!editable)
    return (
      <section aria-label="Deliverable details">
        <div className="section-heading">
          <h2>Details</h2>
        </div>
        <div className="workspace-item-editor flush">
          <small>
            External deadline:{" "}
            {deliverable.externalDeadlineAt ? format.format(new Date(deliverable.externalDeadlineAt)) : "none"}
          </small>
          <small>
            Internal deadline:{" "}
            {deliverable.internalDeadlineAt ? format.format(new Date(deliverable.internalDeadlineAt)) : "none"}
          </small>
          <small>
            Uncertainty {deliverable.uncertainty} · importance {deliverable.importance} · consequence{" "}
            {deliverable.consequence}
          </small>
          <small>
            {deliverable.dependencyIds.length
              ? `After ${deliverable.dependencyIds.map(title).join(", ")}`
              : "No prerequisite deliverables"}
          </small>
          {deliverable.prerequisites?.length ? (
            <small>Also after {deliverable.prerequisites.map((ref) => refTitle(ref)).join(", ")}</small>
          ) : null}
          {deliverable.details && <small>{deliverable.details}</small>}
        </div>
        {connections}
      </section>
    );
  return (
    <section aria-label="Deliverable details">
      <div className="section-heading">
        <h2>Details</h2>
      </div>
      <div className="workspace-item-editor flush">
        <label>
          Title
          <input value={deliverable.title} onChange={(event) => set({ title: event.target.value })} />
        </label>
        <label>
          External deadline
          <input
            type="datetime-local"
            value={dateInput(deliverable.externalDeadlineAt, timezone)}
            onChange={(event) => set({ externalDeadlineAt: dateValue(event.target.value, timezone) })}
          />
        </label>
        <label>
          Internal deadline
          <input
            type="datetime-local"
            value={dateInput(deliverable.internalDeadlineAt, timezone)}
            onChange={(event) => set({ internalDeadlineAt: dateValue(event.target.value, timezone) })}
          />
        </label>
        <label>
          Uncertainty
          <select
            value={deliverable.uncertainty}
            onChange={(event) => set({ uncertainty: event.target.value as StoredDeliverable["uncertainty"] })}
          >
            <option value="known">known</option>
            <option value="some">some</option>
            <option value="high">high</option>
          </select>
        </label>
        <label>
          Importance (1–5)
          <input
            type="number"
            min="1"
            max="5"
            value={deliverable.importance}
            onChange={(event) => set({ importance: Math.min(5, Math.max(1, Number(event.target.value) || 1)) })}
          />
        </label>
        <label>
          Consequence (1–5)
          <input
            type="number"
            min="1"
            max="5"
            value={deliverable.consequence}
            onChange={(event) => set({ consequence: Math.min(5, Math.max(1, Number(event.target.value) || 1)) })}
          />
        </label>
        {/* Checkboxes, not a multi-select: an option list of siblings read as a statement that the
            first of them was a prerequisite, when nothing was selected at all. The whole picker
            folds shut — its summary states the truth — and the candidates fold by project, so the
            panel costs one row until it is being used. */}
        <details className="prerequisite-picker" role="group" aria-label="Must finish first">
          <summary>
            <span>Must finish first</span>
            <small>
              {selected.length
                ? `After ${selected.map((item) => item.title).join(", ")}`
                : "None selected — nothing blocks this deliverable."}
            </small>
          </summary>
          {prerequisites.length === 0 ? (
            <small className="prerequisite-empty">There are no other deliverables this one could wait on.</small>
          ) : (
            <>
              {selected.length > 0 && (
                <div className="prerequisite-selected">{selected.map((item) => option(item, true))}</div>
              )}
              {groups.map((group) => (
                <details className="prerequisite-group" key={group.projectId}>
                  <summary>
                    {group.title} <small>{group.items.length}</small>
                  </summary>
                  {group.items.map((item) => option(item, false))}
                </details>
              ))}
            </>
          )}
        </details>
        <label>
          Notes
          <input
            value={deliverable.details ?? ""}
            onChange={(event) => set({ details: event.target.value || undefined })}
          />
        </label>
      </div>
      {connections}
    </section>
  );
}
