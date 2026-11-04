"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { ImportRecord } from "@openrhen/contracts";
import { plainImportMessage } from "@/features/imports/import-field-labels";
import { describeImportRecordSource } from "@/features/imports/import-record-source";
import {
  IMPORT_TABLE_BLOCKERS_FIRST,
  IMPORT_TABLE_SOURCE_KEY,
  IMPORT_TABLE_STATUS_KEY,
  importBlockerTargets,
  importCellText,
  importRowMessages,
  importRowStatus,
  nextImportTableSort,
  stepBlockerIndex,
  type ImportTableColumn,
  type ImportTableGroup,
  type ImportTableSort
} from "@/features/imports/import-table";
import { ImportFieldInput } from "./import-record-fields";
import type { ImportRecordActions } from "./import-record-card";

/**
 * A workbook read as a workbook: one table per entity type, one row per record, the spec's columns in
 * the order the template writes them. It is the alternative to the cards for a file of fifty to two
 * hundred rows, where a card each means scrolling past four thousand inputs to find the one that is
 * wrong.
 *
 * Only the row being edited holds real inputs; every other cell is a button showing the value, which
 * is what keeps two hundred rows of twenty columns responsive — four thousand cells cost four
 * thousand buttons rather than four thousand controlled form controls. Clicking a cell, or stepping
 * to a blocker, makes its row the edited one.
 *
 * Errors are shown three ways because a table hides them easily: the cell is outlined and carries the
 * message in its tooltip, the leading cell says `blocked`, and the row being edited grows a strip
 * underneath listing everything wrong with it. `]` and `[` walk the blockers; the buttons do the same
 * for a reader whose hands are in a text box, where a bare bracket is a character rather than a
 * command.
 */
export function ImportTable({
  groups,
  sort,
  query,
  onSortChange,
  onQueryChange,
  onOpenCard,
  actions
}: {
  groups: ImportTableGroup[];
  sort: ImportTableSort | null;
  query: string;
  onSortChange: (sort: ImportTableSort | null) => void;
  onQueryChange: (query: string) => void;
  /** Takes the reader to this record's card, where provenance and evidence live. */
  onOpenCard: (recordId: string) => void;
  actions: ImportRecordActions;
}) {
  const [active, setActive] = useState<{ recordId: string; field: string } | null>(null);
  const blockerIndex = useRef(-1);
  const container = useRef<HTMLDivElement>(null);
  const targets = useMemo(() => importBlockerTargets(groups), [groups]);

  // Focus follows the edited cell: a cell just clicked, and above all a cell just stepped to, has to
  // be the one the next keystroke reaches, or "next blocker" only scrolls and the reader has to aim.
  useEffect(() => {
    if (!active) return;
    const cell = container.current?.querySelector<HTMLElement>(
      `[data-cell="${cssEscape(active.recordId)}--${cssEscape(active.field)}"]`
    );
    const control = cell?.querySelector<HTMLElement>("input, select, textarea, button");
    control?.focus();
    control?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const step = (direction: 1 | -1) => {
    if (!targets.length) return;
    blockerIndex.current = stepBlockerIndex(targets.length, blockerIndex.current, direction);
    const target = targets[blockerIndex.current]!;
    setActive({ recordId: target.recordId, field: target.field ?? "importKey" });
  };

  const blockersFirst = () => {
    onSortChange(IMPORT_TABLE_BLOCKERS_FIRST);
    blockerIndex.current = -1;
    step(1);
  };

  return (
    <div
      className="import-table-view"
      ref={container}
      onKeyDown={(event) => {
        if (event.key !== "]" && event.key !== "[") return;
        const target = event.target as HTMLElement;
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
        event.preventDefault();
        step(event.key === "]" ? 1 : -1);
      }}
    >
      <div className="import-table-toolbar">
        <label className="import-table-search">
          <span>Find</span>
          <input
            type="search"
            value={query}
            placeholder="Any cell"
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </label>
        <button type="button" className="quiet small" onClick={blockersFirst} disabled={!targets.length}>
          Blockers first
        </button>
        <button type="button" className="quiet small" onClick={() => step(-1)} disabled={!targets.length}>
          Previous blocker
        </button>
        <button type="button" className="quiet small" onClick={() => step(1)} disabled={!targets.length}>
          Next blocker
        </button>
        <span className="import-table-hint">
          {targets.length
            ? `${targets.length} blocking cell${targets.length === 1 ? "" : "s"} · ] and [ to walk them`
            : "No blockers"}
        </span>
      </div>
      {groups.map((group) => (
        <div className="import-table-group" key={group.type}>
          <h3>{group.label}</h3>
          <div className="import-table-scroll">
            <table className="import-table">
              <thead>
                <tr>
                  <th scope="col" aria-sort={ariaSort(sort, IMPORT_TABLE_STATUS_KEY)}>
                    <HeaderButton label="status" sortKey={IMPORT_TABLE_STATUS_KEY} sort={sort} onSort={onSortChange} />
                  </th>
                  <th scope="col" aria-sort={ariaSort(sort, IMPORT_TABLE_SOURCE_KEY)}>
                    <HeaderButton label="row" sortKey={IMPORT_TABLE_SOURCE_KEY} sort={sort} onSort={onSortChange} />
                  </th>
                  {group.columns.map((column) => (
                    <th scope="col" key={column.name} aria-sort={ariaSort(sort, column.name)}>
                      <HeaderButton label={column.header} sortKey={column.name} sort={sort} onSort={onSortChange} />
                    </th>
                  ))}
                  <th scope="col">actions</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((record) => (
                  <Row
                    key={record.id}
                    record={record}
                    columns={group.columns}
                    editing={active?.recordId === record.id}
                    onActivate={(field) => setActive({ recordId: record.id, field })}
                    onOpenCard={onOpenCard}
                    actions={actions}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {!groups.length && <p className="empty">No rows match this filter.</p>}
    </div>
  );
}

const ariaSort = (sort: ImportTableSort | null, key: string) =>
  sort?.key === key ? (sort.direction === "asc" ? "ascending" : "descending") : "none";

function HeaderButton({
  label,
  sortKey,
  sort,
  onSort
}: {
  label: string;
  sortKey: string;
  sort: ImportTableSort | null;
  onSort: (sort: ImportTableSort | null) => void;
}) {
  const active = sort?.key === sortKey;
  return (
    <button type="button" className="import-table-sort" onClick={() => onSort(nextImportTableSort(sort, sortKey))}>
      {label}
      <span aria-hidden="true">{active ? (sort!.direction === "asc" ? "▲" : "▼") : ""}</span>
    </button>
  );
}

function Row({
  record,
  columns,
  editing,
  onActivate,
  onOpenCard,
  actions
}: {
  record: ImportRecord;
  columns: readonly ImportTableColumn[];
  editing: boolean;
  onActivate: (field: string) => void;
  onOpenCard: (recordId: string) => void;
  actions: ImportRecordActions;
}) {
  const status = importRowStatus(record);
  const messages = importRowMessages(record, columns);
  const source = describeImportRecordSource(record);
  // Read the way the card reads them: plain field labels, instants in the batch's zone.
  const readingZone = actions.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const fieldNames = Object.keys(record.fields);
  const plain = (message: string) => plainImportMessage(message, fieldNames, readingZone);
  // Everything wrong with the row, cell-addressed or not, so the strip is the whole account of it.
  const strip = editing ? [...new Set([...record.errors, ...record.warnings].map(plain))] : [];
  return (
    <>
      <tr className={`import-table-row ${status}${editing ? " editing" : ""}`}>
        <th scope="row">
          <span className={`import-row-status ${status}`}>{status}</span>
        </th>
        <td className="import-table-source">{source ?? "—"}</td>
        {columns.map((column) => (
          <Cell
            key={column.name}
            record={record}
            column={column}
            editing={editing}
            errors={(messages.byField[column.name] ?? []).map(plain)}
            onActivate={() => onActivate(column.name)}
            actions={actions}
          />
        ))}
        <td className="import-table-actions">
          <button type="button" className="quiet small" onClick={() => onOpenCard(record.id)}>
            Card
          </button>
          <button type="button" className="quiet small" onClick={() => actions.toggleRemoved(record.id)}>
            {record.removed ? "Restore" : "Remove"}
          </button>
        </td>
      </tr>
      {strip.length > 0 && (
        <tr className="import-table-messages">
          <td colSpan={columns.length + 3}>
            {strip.map((message) => (
              <span key={message}>{message}</span>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A cell holds its input only while its row is being edited; otherwise it is a button showing the
 * text, which is what a table of two hundred rows can afford to draw. The button reads the same value
 * the input would, so the switch is invisible apart from the caret arriving.
 */
function Cell({
  record,
  column,
  editing,
  errors,
  onActivate,
  actions
}: {
  record: ImportRecord;
  column: ImportTableColumn;
  editing: boolean;
  errors: string[];
  onActivate: () => void;
  actions: ImportRecordActions;
}) {
  const text = importCellText(record, column);
  const invalid = errors.length > 0;
  const className = `import-table-cell ${column.kind}${invalid ? " has-error" : ""}`;
  const title = invalid ? errors.join(" ") : undefined;
  const disabled =
    record.removed || record.operation === "delete" || record.operation === "link" || record.operation === "unlink";
  if (!editing || column.readOnly)
    return (
      <td className={className} data-cell={`${record.id}--${column.name}`} title={title}>
        <button
          type="button"
          className={`import-cell-view${column.readOnly ? " key" : ""}`}
          aria-invalid={invalid || undefined}
          onClick={onActivate}
        >
          {text || "—"}
        </button>
      </td>
    );
  const suggestions = column.targetType ? actions.batchKeys?.[column.targetType] : undefined;
  const listId = suggestions ? `${record.id}-${column.name}-keys` : undefined;
  return (
    <td className={className} data-cell={`${record.id}--${column.name}`} title={title}>
      {column.relation ? (
        <>
          <input
            list={listId}
            aria-label={column.header}
            aria-invalid={invalid || undefined}
            disabled={record.removed}
            value={text}
            onChange={(event) => actions.updateRelationship(record.id, column.name, event.target.value)}
          />
          {suggestions ? (
            <datalist id={listId}>
              {suggestions
                .filter((key) => key !== record.importKey || column.targetType !== record.entityType)
                .map((key) => (
                  <option value={key} key={key} />
                ))}
            </datalist>
          ) : null}
        </>
      ) : (
        <ImportFieldInput
          record={record}
          name={column.name}
          value={record.fields[column.name]?.value ?? null}
          column={column.column}
          disabled={disabled}
          compact
          conditionCatalog={actions.conditionCatalog}
          places={actions.places}
          updateField={actions.updateField}
          applyLocation={actions.applyLocation}
          createCustomLocation={actions.createCustomLocation}
          timeZone={actions.timezone}
        />
      )}
    </td>
  );
}

/** Record ids and field names are safe in a selector, but a batch is not the place to find that out. */
const cssEscape = (value: string) => value.replaceAll(/["\\]/g, "\\$&");
