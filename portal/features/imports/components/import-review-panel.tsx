"use client";

import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ImportBatch, ImportRecord } from "@openrhen/contracts";
import { useMediaQuery } from "@/shared/use-media-query";
import {
  countBlankDefaults,
  countBlockingImportRecords,
  type ImportRecordFilter
} from "@/features/imports/import-batch-edits";
import {
  buildImportTableGroups,
  importTableRows,
  readImportReviewView,
  resolveImportReviewView,
  supportsImportTableView,
  writeImportReviewView,
  type ImportReviewView,
  type ImportTableSort
} from "@/features/imports/import-table";
import { ImportRecordEditor } from "./import-record-editor";
import { ImportTable } from "./import-table";
import type { ImportRecordActions } from "./import-record-card";

const filters: ImportRecordFilter[] = ["all", "ready", "needs", "warnings", "rejected"];

function subscribeToStorage(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

/** The batch as it will commit: a removed record stays listed (under its filter) but is no longer counted in. */
function batchCountLine(records: ImportRecord[], blocking: number): string {
  const removed = records.filter((record) => record.removed).length;
  const kept = records.length - removed;
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  return [plural(kept, "record"), removed ? `${removed} removed` : null, plural(blocking, "blocker")]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The counts above the list describe the whole batch, not the current filter, so narrowing the view
 * to warnings never makes it look as though the blockers went away. They also describe the batch as
 * it stands after the edits made here, which is not what the server has been told: `pendingEdits`
 * says so out loud rather than letting a reader believe a fixed batch is a committable one.
 *
 * The two bulk actions work on what is in view, so both the filter and the table's search decide
 * their reach — a button that says "remove 4 blockers" must mean the four the reader can see.
 * Removing rows is confirmed in place: it is the one of the two that throws work away.
 *
 * A batch read from a workbook or CSV can be read either as cards or as a table. Cards carry
 * provenance, evidence, the calendar provider conflicts and the routine preview, so an AI or calendar batch only
 * ever gets cards; a file of named columns can be read as the sheet it was, which is what makes two
 * hundred rows reviewable. The choice is remembered, a batch of more than a dozen rows opens as a
 * table by default, and a narrow screen is always cards.
 */
export function ImportReviewPanel({
  records,
  visibleRecords,
  sourceType,
  filter,
  blocking,
  ready,
  pendingEdits,
  calendarCount,
  selectedCalendarCount,
  onFilterChange,
  onCalendarSelection,
  onApplyDefaults,
  onRemoveBlockers,
  recordActions,
  banners
}: {
  records: ImportRecord[];
  visibleRecords: ImportRecord[];
  /** Which source produced the batch, since only a file of named columns can be read as a table. */
  sourceType: ImportBatch["sourceType"];
  filter: ImportRecordFilter;
  blocking: number;
  ready: number;
  pendingEdits: boolean;
  calendarCount: number;
  selectedCalendarCount: number;
  onFilterChange: (filter: ImportRecordFilter) => void;
  onCalendarSelection: (selected: boolean) => void;
  onApplyDefaults: (records: ImportRecord[]) => void;
  onRemoveBlockers: (records: ImportRecord[]) => void;
  recordActions: ImportRecordActions;
  /** Whatever the page wants said about this batch, shown where the batch is being read. */
  banners?: React.ReactNode;
}) {
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [chosen, setChosen] = useState<ImportReviewView | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ImportTableSort | null>(null);
  // A fresh object per request, so asking for the same record again is a new request.
  const [cardRequest, setCardRequest] = useState<{ recordId: string } | null>(null);
  const handledCardRequest = useRef<{ recordId: string } | null>(null);
  // A table needs the room a phone does not have, and the remembered choice can only be read once
  // there is a browser to read it from.
  const wide = useMediaQuery("(min-width: 768px)");
  // What an earlier visit remembered, read from browser storage once there is one (null on the server
  // and while hydrating), unless a choice made on this panel since then outranks it.
  const remembered = useSyncExternalStore(subscribeToStorage, readImportReviewView, () => null);
  const stored = chosen ?? remembered;
  const view = resolveImportReviewView(sourceType, records.length, stored, wide);
  const offerTable = supportsImportTableView(sourceType) && wide;

  const groups = useMemo(
    () => (view === "table" ? buildImportTableGroups(visibleRecords, { query, sort }) : []),
    [view, visibleRecords, query, sort]
  );
  /** What the bulk actions reach: the filter, and in a table the search on top of it. */
  const scoped = view === "table" ? importTableRows(groups) : visibleRecords;
  const blanks = countBlankDefaults(scoped);
  const removable = countBlockingImportRecords(scoped);

  const choose = (next: ImportReviewView) => {
    setChosen(next);
    writeImportReviewView(next);
  };

  // "Card" on a table row is a request to see that record's provenance, so the panel changes how it
  // is reading and takes the reader to the card rather than leaving them to find it.
  useEffect(() => {
    if (!cardRequest || view !== "cards" || handledCardRequest.current === cardRequest) return;
    handledCardRequest.current = cardRequest;
    document
      .getElementById(`import-record-${cardRequest.recordId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cardRequest, view]);

  return (
    <section>
      <div className="section-heading">
        <h2>Review batch</h2>
        <span>{batchCountLine(records, blocking)}</span>
      </div>
      {banners}
      <div className="import-summary">
        <span>
          {records.filter((r) => r.operation === "create" && !r.removed).length}
          <small>creates</small>
        </span>
        <span>
          {records.filter((r) => r.operation === "update" && !r.removed).length}
          <small>updates</small>
        </span>
        <span>
          {records.filter((r) => r.operation === "link" && !r.removed).length}
          <small>links</small>
        </span>
        <span>
          {records.filter((r) => r.warnings.length && !r.removed).length}
          <small>warnings</small>
        </span>
        <span>
          {blocking}
          <small>blockers</small>
        </span>
      </div>
      {pendingEdits && (
        <p className="save-notice" role="status">
          {ready} ready after your edits · save the draft to confirm
        </p>
      )}
      <div className="filter-row">
        {filters.map((item) => (
          <Button
            variant={filter === item ? "primary" : "secondary"}
            aria-pressed={filter === item}
            size="sm"
            onClick={() => onFilterChange(item)}
            key={item}
          >
            {item}
          </Button>
        ))}
        {offerTable && (
          <span className="import-view-toggle" role="group" aria-label="Review layout">
            <Button
              type="button"
              variant={view === "cards" ? "primary" : "secondary"}
              aria-pressed={view === "cards"}
              size="sm"
              onClick={() => choose("cards")}
            >
              Cards
            </Button>
            <Button
              type="button"
              variant={view === "table" ? "primary" : "secondary"}
              aria-pressed={view === "table"}
              size="sm"
              onClick={() => choose("table")}
            >
              Table
            </Button>
          </span>
        )}
      </div>
      <div className="bulk-actions">
        <Button type="button" variant="secondary" size="sm" disabled={!blanks} onClick={() => onApplyDefaults(scoped)}>
          {blanks ? `Apply defaults to ${blanks} blank fields` : "Apply defaults to all blank fields"}
        </Button>
        {confirmingRemoval ? (
          <span className="bulk-confirm">
            Remove {removable} record{removable === 1 ? "" : "s"} that still {removable === 1 ? "has" : "have"} errors?
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => {
                setConfirmingRemoval(false);
                onRemoveBlockers(scoped);
              }}
            >
              Remove
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setConfirmingRemoval(false)}>
              Keep them
            </Button>
          </span>
        ) : (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!removable}
            onClick={() => setConfirmingRemoval(true)}
          >
            {removable ? `Remove ${removable} blockers` : "Remove all blockers"}
          </Button>
        )}
      </div>
      {calendarCount > 0 && (
        <div className="calendar-selection-toolbar">
          <div>
            <strong>
              {selectedCalendarCount} of {calendarCount} events selected
            </strong>
            <span>Only checked events will be validated and imported.</span>
          </div>
          <div className="actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => onCalendarSelection(true)}>
              Select all
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => onCalendarSelection(false)}>
              Clear selection
            </Button>
          </div>
        </div>
      )}
      {view === "table" ? (
        <ImportTable
          groups={groups}
          sort={sort}
          query={query}
          onSortChange={setSort}
          onQueryChange={setQuery}
          onOpenCard={(recordId) => {
            choose("cards");
            setCardRequest({ recordId });
          }}
          actions={recordActions}
        />
      ) : (
        visibleRecords.map((record) => (
          <div id={`import-record-${record.id}`} key={record.id}>
            <ImportRecordEditor record={record} {...recordActions} />
          </div>
        ))
      )}
      {view === "cards" && !visibleRecords.length && <p className="empty">No records match this filter.</p>}
    </section>
  );
}
