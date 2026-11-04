"use client";

import { useState, type FormEvent } from "react";
import type { PlanLink, PlanMap } from "@openrhen/contracts";
import {
  availableRelations,
  candidatesFor,
  describeItemLink,
  itemHandle,
  linkInputFor,
  linksForItem,
  type ConnectionCandidate,
  type ItemRef,
  type Relation,
  type TitleResolver
} from "@/features/plan-map/plan-map-model";
import { mapHref } from "@/features/plan-map/map-view-model";
import type { PlanMapLoad } from "@/features/plan-map/use-plan-map";

const TYPE_GROUP_LABELS: Record<string, string> = {
  subject: "Subjects",
  outcome: "Outcomes",
  project: "Projects",
  deliverable: "Deliverables",
  action: "Actions",
  commitment: "Commitments"
};

/**
 * One item's connections: the links it already has (confirmed ones with Remove, suggested ones drawn
 * dashed and marked suggested with Confirm and Reject) and a form to add one by hand. A subject with
 * `about` is the default; the other kinds are offered only where the contract allows the item at that
 * end, and only with something to choose.
 */
export function ConnectionsPanel({
  item,
  recurring = false,
  map,
  status,
  error,
  actionError,
  busy,
  resolver,
  candidates,
  onRetry,
  onAdd,
  onDecide
}: {
  item: ItemRef;
  /** The item is a recurring series' rule: a link applies to every occurrence. */
  recurring?: boolean;
  map: PlanMap | null;
  status: PlanMapLoad;
  error: string;
  actionError: string;
  busy: boolean;
  resolver: TitleResolver;
  candidates: readonly ConnectionCandidate[];
  onRetry: () => void;
  onAdd: (input: ReturnType<typeof linkInputFor>) => Promise<boolean>;
  onDecide: (link: PlanLink, action: "confirm" | "reject" | "remove") => void;
}) {
  const views = linksForItem(map, item);
  const links = map?.links ?? [];
  const relations = availableRelations(item, candidates, links);
  const [relationKey, setRelationKey] = useState("");
  const [targetKey, setTargetKey] = useState("");
  const key = (relation: Relation) => `${relation.kind}:${relation.direction}`;
  const relation = relations.find((entry) => key(entry) === relationKey) ?? relations[0] ?? null;
  const targets = relation ? candidatesFor(relation, item, candidates, links) : [];
  // No target until one is picked: defaulting to the first one let a stray press save a link nobody chose.
  const target = targets.find((entry) => `${entry.type}:${entry.id}` === targetKey) ?? null;
  const groups = [...new Set(targets.map((entry) => entry.type))];

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!relation || !target) return;
    const saved = await onAdd(linkInputFor(relation, item, target));
    if (saved) setTargetKey("");
  }

  return (
    <section className="plan-map-connections" aria-label="Connections">
      <div className="section-heading">
        <h2>Connections</h2>
      </div>
      {recurring && (
        <p className="microcopy">
          This is a series. A connection is made to the series itself, so it applies to every occurrence.
        </p>
      )}
      {status === "loading" && !map && <p className="microcopy">Loading connections...</p>}
      {status === "error" && (
        <div className="plan-map-error" role="status">
          <span>{error || "Connections could not be loaded."}</span>
          <button type="button" className="quiet small" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      {status === "ready" && views.length > 0 && (
        <p className="microcopy">
          <a href={mapHref(itemHandle(item.type, item.id))}>See it on the map</a>
        </p>
      )}
      {status === "ready" && views.length === 0 && <p className="empty">Nothing is connected to this yet.</p>}
      {views.length > 0 && (
        <ul className="plan-map-connection-list">
          {views.map((view) => {
            const suggested = view.link.status === "suggested";
            return (
              <li className={`plan-map-row${suggested ? " suggested" : ""}`} key={view.link.id}>
                <div className="plan-map-row-body">
                  <p>
                    {describeItemLink(view, resolver.titleOf)}
                    {suggested && <span className="plan-map-tag"> suggested</span>}
                  </p>
                  {suggested && (
                    <p className="microcopy">
                      Suggested by {view.link.proposer}. It changes nothing until confirmed.
                      {view.link.evidence.length ? ` ${view.link.evidence.join(" · ")}` : ""}
                    </p>
                  )}
                </div>
                <div className="actions">
                  {suggested ? (
                    <>
                      <button
                        type="button"
                        className="small"
                        disabled={busy}
                        onClick={() => onDecide(view.link, "confirm")}
                      >
                        Confirm
                      </button>
                      <button
                        type="button"
                        className="quiet small"
                        disabled={busy}
                        onClick={() => onDecide(view.link, "reject")}
                      >
                        Reject
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="quiet small"
                      disabled={busy}
                      onClick={() => onDecide(view.link, "remove")}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {status === "ready" && relation && targets.length > 0 && (
        <form className="plan-map-add" onSubmit={(event) => void submit(event)}>
          <label>
            <span>This item</span>
            <select value={key(relation)} onChange={(event) => setRelationKey(event.target.value)}>
              {relations.map((entry) => (
                <option key={key(entry)} value={key(entry)}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Connect to</span>
            <select
              value={target ? `${target.type}:${target.id}` : ""}
              onChange={(event) => setTargetKey(event.target.value)}
            >
              <option value="" disabled>
                Choose…
              </option>
              {groups.map((type) => (
                <optgroup key={type} label={TYPE_GROUP_LABELS[type] ?? type}>
                  {targets
                    .filter((entry) => entry.type === type)
                    .map((entry) => (
                      <option key={`${entry.type}:${entry.id}`} value={`${entry.type}:${entry.id}`}>
                        {entry.title}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button type="submit" className="small" disabled={busy || !target}>
            Add connection
          </button>
        </form>
      )}
    </section>
  );
}
