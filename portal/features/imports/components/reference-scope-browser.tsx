"use client";

import { useState } from "react";
import {
  referenceCounts,
  referenceCrumbs,
  referenceRows,
  scopeCovers,
  scopeKey,
  scopeLabel,
  type ReferenceLocation
} from "@/features/imports/reference-pack-scopes";
import type { ReferencePackScope } from "@/features/imports/reference-pack-types";
import type { PortalState } from "@/state/portal-state";

/**
 * Selection is kept minimal on purpose: ticking a folder drops the descendants already chosen, and a
 * record covered by a ticked ancestor cannot be ticked separately. The query sent to the reference
 * routes then says what the user meant once, rather than the same records several ways.
 */
export function ReferenceScopeBrowser({
  state,
  selected,
  onChange
}: {
  state: PortalState;
  selected: ReferencePackScope[];
  onChange: (scopes: ReferencePackScope[]) => void;
}) {
  const [location, setLocation] = useState<ReferenceLocation>({ type: "root" });
  const [search, setSearch] = useState("");
  const rows = referenceRows(state, location).filter((row) =>
    `${row.label} ${row.detail}`.toLowerCase().includes(search.trim().toLowerCase())
  );
  const crumbs = referenceCrumbs(state, location);
  const counts = referenceCounts(state, selected);

  function navigate(next: ReferenceLocation) {
    setLocation(next);
    setSearch("");
  }
  function toggle(scope: ReferencePackScope) {
    const exact = selected.some((item) => scopeKey(item) === scopeKey(scope));
    if (exact) return onChange(selected.filter((item) => scopeKey(item) !== scopeKey(scope)));
    if (selected.some((item) => scopeCovers(state, item, scope))) return;
    onChange([...selected.filter((item) => !scopeCovers(state, scope, item)), scope]);
  }

  return (
    <div className="reference-browser" aria-label="Reference scope">
      <div className="reference-browser-toolbar">
        <div className="reference-breadcrumbs">
          {crumbs.map((crumb, index) => (
            <span key={crumb.label}>
              {index > 0 && <b>/</b>}
              <button type="button" className="quiet small" onClick={() => navigate(crumb.location)}>
                {crumb.label}
              </button>
            </span>
          ))}
        </div>
        <button type="button" className="quiet small" disabled={!selected.length} onClick={() => onChange([])}>
          Clear selection
        </button>
      </div>
      <label className="field reference-search">
        <span>Search this folder</span>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name"
        />
      </label>
      <div className="reference-browser-list">
        {rows.map((row) => {
          const exact = selected.some((item) => scopeKey(item) === scopeKey(row.scope));
          const covering = selected.find(
            (item) => scopeKey(item) !== scopeKey(row.scope) && scopeCovers(state, item, row.scope)
          );
          return (
            <div className={`reference-browser-row ${exact || covering ? "selected" : ""}`} key={scopeKey(row.scope)}>
              <label title={covering ? "Already included by a selected parent folder." : undefined}>
                <input
                  type="checkbox"
                  checked={exact || Boolean(covering)}
                  disabled={Boolean(covering)}
                  onChange={() => toggle(row.scope)}
                />
                <span>
                  <strong>
                    {row.location ? "📁 " : ""}
                    {row.label}
                  </strong>
                  <small>{covering ? "Included by a selected parent" : row.detail}</small>
                </span>
              </label>
              {row.location && (
                <button type="button" className="quiet small" onClick={() => navigate(row.location!)}>
                  Enter{row.childCount ? ` · ${row.childCount}` : ""}
                </button>
              )}
            </div>
          );
        })}
        {!rows.length && <p className="empty">No records match this folder search.</p>}
      </div>
      <div className="reference-selection-summary">
        <div className="section-heading">
          <strong>Selected reference</strong>
          <span>
            {selected.length} scope{selected.length === 1 ? "" : "s"}
          </span>
        </div>
        {selected.length ? (
          <>
            <div className="reference-chips">
              {selected.map((scope) => (
                <button
                  type="button"
                  className="quiet small"
                  key={scopeKey(scope)}
                  onClick={() => onChange(selected.filter((item) => scopeKey(item) !== scopeKey(scope)))}
                >
                  {scopeLabel(state, scope)} ×
                </button>
              ))}
            </div>
            <p className="microcopy">
              Result: {counts.areas} areas · {counts.outcomes} outcomes · {counts.projects} projects ·{" "}
              {counts.deliverables} deliverables · {counts.actions} actions · {counts.commitments} commitments. Required
              ancestors and prerequisites are included automatically.
            </p>
          </>
        ) : (
          <p className="microcopy">
            Choose one or more folders or records. Downloads stay disabled until something is selected.
          </p>
        )}
      </div>
    </div>
  );
}
