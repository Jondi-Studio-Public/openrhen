import type { ImportBatch, ImportEntityType, ImportRecord } from "@openrhen/contracts";
import { displayFieldValue } from "./import-field-values";
import { describeImportRecordSource, importRecordSource } from "./import-record-source";
import { IMPORT_ENTITY_ORDER, importFieldKind, importSpecForType } from "./import-spec";
import type { ImportColumnKind, ImportColumnSpec } from "./import-spec";

/**
 * The table way of reading a batch: one row per record, one column per spec column, for the fifty to
 * two hundred rows a workbook usually carries. Everything here is a pure function over records and
 * the spec — which columns a table has, how a column sorts, what a search matches, and the order the
 * blockers are visited in — so the component can hold nothing but which cell is being edited.
 *
 * A record card stays the richer reading: it carries provenance, evidence, the calendar provider conflicts and the
 * routine preview. The table is for a file whose columns were named by the person who filled it in,
 * so only `csv` and `xlsx` batches offer it.
 */
export type ImportReviewView = "cards" | "table";

export const IMPORT_VIEW_STORAGE_KEY = "openrhen.import-review-view";

/** Above this many rows a structured batch opens as a table unless the reader has said otherwise. */
export const IMPORT_TABLE_DEFAULT_THRESHOLD = 12;

/** Only a source with named columns has a table to show; an extraction or a calendar pull does not. */
export function supportsImportTableView(sourceType: ImportBatch["sourceType"]): boolean {
  return sourceType === "csv" || sourceType === "xlsx";
}

/**
 * Which way this batch opens. A narrow screen is always cards — a table wide enough to hold twenty
 * columns is a desk affordance and nothing useful survives being squeezed onto a phone. Otherwise a
 * remembered choice wins, and with none the size of the batch decides: a handful of rows reads better
 * as cards, a workbook's worth reads better as a table.
 */
export function resolveImportReviewView(
  sourceType: ImportBatch["sourceType"],
  recordCount: number,
  stored: ImportReviewView | null,
  wide: boolean
): ImportReviewView {
  if (!wide || !supportsImportTableView(sourceType)) return "cards";
  if (stored) return stored;
  return recordCount > IMPORT_TABLE_DEFAULT_THRESHOLD ? "table" : "cards";
}

/** The remembered choice, or null when nothing has been chosen or storage cannot be read. */
export function readImportReviewView(): ImportReviewView | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(IMPORT_VIEW_STORAGE_KEY);
    return stored === "cards" || stored === "table" ? stored : null;
  } catch {
    return null;
  }
}

export function writeImportReviewView(view: ImportReviewView): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(IMPORT_VIEW_STORAGE_KEY, view);
  } catch {
    // A browser that refuses storage still gets the view it asked for, just not the memory of it.
  }
}

export interface ImportTableColumn {
  /** The field or relationship name on the record, e.g. `expectedMinutes` or `projectKey`. */
  name: string;
  /** The header the file used, which is what the reader typed under and recognises. */
  header: string;
  kind: ImportColumnKind;
  /** Relationship keys are edited through `updateRelationship`, fields through `updateField`. */
  relation: boolean;
  /** The import key names the row and is never typed over here. */
  readOnly?: boolean;
  /** The spec behind a field column, so a cell can offer the enum, the default and the help. */
  column?: ImportColumnSpec;
  /** Which entity a relationship key names, so the batch's own keys can be suggested. */
  targetType?: ImportEntityType;
}

/**
 * The columns for one entity type, in the order a downloaded template writes them: the key, then the
 * relationships, then the spec's own columns. A field a record carries that the spec has never heard
 * of — an older batch, a column since renamed — is appended rather than dropped, so nothing a batch
 * holds becomes invisible just because the table draws it.
 */
export function importTableColumns(type: ImportEntityType, records: readonly ImportRecord[]): ImportTableColumn[] {
  const spec = importSpecForType(type);
  const columns: ImportTableColumn[] = [
    { name: "importKey", header: "import_key", kind: "text", relation: false, readOnly: true }
  ];
  for (const relation of spec?.relations ?? [])
    columns.push({
      name: relation.name,
      header: relation.header,
      kind: "text",
      // A relation the spec carries as a field is edited as a field; only a key that lives in
      // `relationships` is written through `updateRelationship`.
      relation: !relation.asField,
      targetType: relation.targetType
    });
  for (const column of spec?.columns ?? [])
    columns.push({ name: column.name, header: column.header, kind: column.kind, relation: false, column });
  const known = new Set(columns.map((column) => column.name));
  for (const record of records)
    for (const name of Object.keys(record.fields))
      if (!known.has(name)) {
        known.add(name);
        columns.push({ name, header: name, kind: importFieldKind(name), relation: false });
      }
  return columns;
}

/** What a cell reads as: the same text the card's input would hold. */
export function importCellText(record: ImportRecord, column: ImportTableColumn): string {
  if (column.readOnly) return record.importKey;
  if (column.relation) return record.relationships[column.name] ?? "";
  return displayFieldValue(record.fields[column.name]?.value ?? null, column.kind);
}

export type ImportRowStatus = "blocked" | "warning" | "ready" | "removed";

/** The one word the leading cell says about a row, and the order "blockers first" puts them in. */
export function importRowStatus(record: ImportRecord): ImportRowStatus {
  if (record.removed) return "removed";
  if (record.errors.length || record.operation === "conflict") return "blocked";
  if (record.warnings.length) return "warning";
  return "ready";
}

const STATUS_RANK: Record<ImportRowStatus, number> = { blocked: 0, warning: 1, ready: 2, removed: 3 };

/** Sort keys that name something other than a column: the status cell and the file row. */
export const IMPORT_TABLE_STATUS_KEY = "_status";
export const IMPORT_TABLE_SOURCE_KEY = "_source";

/** The preset that puts everything still blocking a commit at the top of every table. */
export const IMPORT_TABLE_BLOCKERS_FIRST: ImportTableSort = { key: IMPORT_TABLE_STATUS_KEY, direction: "asc" };

export interface ImportTableSort {
  key: string;
  direction: "asc" | "desc";
}

/** Clicking a header cycles ascending, descending, then back to the order the file was read in. */
export function nextImportTableSort(current: ImportTableSort | null, key: string): ImportTableSort | null {
  if (current?.key !== key) return { key, direction: "asc" };
  return current.direction === "asc" ? { key, direction: "desc" } : null;
}

/**
 * What a cell sorts by. A number sorts as one, an enum by the order its spec lists — so a status
 * ladder reads as a ladder rather than alphabetically — and everything else by its text. A blank is
 * null and always sorts last, in either direction: a column sorted to find its largest value should
 * not first show every row that has none.
 */
function sortValue(record: ImportRecord, column: ImportTableColumn): number | string | null {
  const text = importCellText(record, column);
  if (!text) return null;
  if (column.kind === "number") {
    const value = Number(text);
    return Number.isFinite(value) ? value : text.toLowerCase();
  }
  if (column.kind === "boolean") return text === "true" ? 1 : 0;
  if (column.kind === "enum" && column.column?.enum) {
    const index = column.column.enum.indexOf(text);
    return index < 0 ? column.column.enum.length : index;
  }
  return text.toLowerCase();
}

function keyValue(record: ImportRecord, key: string, columns: readonly ImportTableColumn[]): number | string | null {
  if (key === IMPORT_TABLE_STATUS_KEY) return STATUS_RANK[importRowStatus(record)];
  if (key === IMPORT_TABLE_SOURCE_KEY) return importRecordSource(record).row;
  const column = columns.find((item) => item.name === key);
  return column ? sortValue(record, column) : null;
}

function compareValues(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

/**
 * Stable throughout: rows the sort cannot tell apart keep the order the file gave them, and a
 * descending sort reverses only the comparison, never the tie-break, so a second click on a header
 * does not shuffle rows that share a value.
 */
export function sortImportTableRows(
  records: readonly ImportRecord[],
  columns: readonly ImportTableColumn[],
  sort: ImportTableSort | null
): ImportRecord[] {
  if (!sort) return [...records];
  const known =
    sort.key === IMPORT_TABLE_STATUS_KEY ||
    sort.key === IMPORT_TABLE_SOURCE_KEY ||
    columns.some((column) => column.name === sort.key);
  if (!known) return [...records];
  return records
    .map((record, index) => ({ record, index, value: keyValue(record, sort.key, columns) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const compared = compareValues(a.value, b.value);
      return (sort.direction === "desc" ? -compared : compared) || a.index - b.index;
    })
    .map((item) => item.record);
}

/** Whether a row shows the searched-for text anywhere the reader can see it. */
export function importRowMatches(record: ImportRecord, columns: readonly ImportTableColumn[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  if (record.importKey.toLowerCase().includes(needle)) return true;
  if ((describeImportRecordSource(record) ?? "").toLowerCase().includes(needle)) return true;
  return columns.some((column) => importCellText(record, column).toLowerCase().includes(needle));
}

export interface ImportTableGroup {
  type: ImportEntityType;
  /** The sheet the rows came from, which is also what the heading above the table says. */
  label: string;
  columns: ImportTableColumn[];
  rows: ImportRecord[];
}

const entityRank = (type: ImportEntityType) => {
  const index = (IMPORT_ENTITY_ORDER as readonly string[]).indexOf(type);
  return index < 0 ? IMPORT_ENTITY_ORDER.length : index;
};

/**
 * One table per entity type, because entity types do not share columns — an action's twenty and an
 * area's four have nothing to line up. Tables come in commit order, parents before the rows that
 * point at them, which is also the order they were filled in. A group left empty by the search is
 * dropped so an untouched entity does not sit there as a bare heading.
 */
export function buildImportTableGroups(
  records: readonly ImportRecord[],
  options: { query?: string; sort?: ImportTableSort | null } = {}
): ImportTableGroup[] {
  const byType = new Map<ImportEntityType, ImportRecord[]>();
  for (const record of records) {
    const rows = byType.get(record.entityType);
    if (rows) rows.push(record);
    else byType.set(record.entityType, [record]);
  }
  return [...byType.entries()]
    .sort(([a], [b]) => entityRank(a) - entityRank(b))
    .map(([type, rows]) => {
      const columns = importTableColumns(type, rows);
      const matched = rows.filter((record) => importRowMatches(record, columns, options.query ?? ""));
      return {
        type,
        label: importSpecForType(type)?.sheetName ?? type.replaceAll("_", " "),
        columns,
        rows: sortImportTableRows(matched, columns, options.sort ?? null)
      };
    })
    .filter((group) => group.rows.length > 0);
}

/** Every row on screen, in the order the tables show them. What the bulk actions reach. */
export function importTableRows(groups: readonly ImportTableGroup[]): ImportRecord[] {
  return groups.flatMap((group) => group.rows);
}

/**
 * Which column a validation message is about. Most name their field first — `expectedMinutes is
 * required.` — and a few are written as sentences about a rule that spans several columns, which are
 * listed here so that "Effort must follow optimistic ≤ expected ≤ pessimistic." still outlines the
 * three cells the reader has to look at. Anything left over belongs to the row rather than a cell.
 */
const SENTENCE_FIELDS: readonly (readonly [RegExp, readonly string[]])[] = [
  [/^Effort must follow/, ["optimisticMinutes", "expectedMinutes", "pessimisticMinutes"]],
  [/^Remaining effort must be/, ["remainingMinutes", "pessimisticMinutes"]],
  [/^Session bounds are invalid/, ["minimumSessionMinutes", "maximumSessionMinutes"]],
  [/^Internal deadline cannot be after/, ["internalDeadlineAt", "externalDeadlineAt"]],
  [/^End time must be after start time/, ["startsAt", "endsAt"]],
  [/^Area names must be unique/, ["name"]],
  [/^Duplicate import key/, ["importKey"]]
];

function fieldsNamedBy(message: string, columns: readonly ImportTableColumn[]): string[] {
  for (const [pattern, names] of SENTENCE_FIELDS)
    if (pattern.test(message)) return names.filter((name) => columns.some((column) => column.name === name));
  const prefixed = columns.find(
    (column) => message.startsWith(`${column.name} `) || message.startsWith(`${column.header} `)
  );
  if (prefixed) return [prefixed.name];
  const mentioned = columns.filter((column) =>
    [column.name, column.header].some((word) =>
      new RegExp(`\\b${word.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(message)
    )
  );
  return mentioned.map((column) => column.name);
}

export interface ImportRowMessages {
  /** Messages against the cell they are about, so the cell can be outlined and titled. */
  byField: Record<string, string[]>;
  /** Messages about the row as a whole — a cycle, a stale version — which no cell owns. */
  row: string[];
}

export function importRowMessages(record: ImportRecord, columns: readonly ImportTableColumn[]): ImportRowMessages {
  const byField: Record<string, string[]> = {};
  const row: string[] = [];
  for (const message of [...record.errors, ...record.warnings]) {
    const names = fieldsNamedBy(message, columns);
    if (!names.length) row.push(message);
    for (const name of names) (byField[name] ??= []).push(message);
  }
  return { byField, row };
}

export interface ImportBlockerTarget {
  recordId: string;
  /** The cell to put the caret in, or null when the message is about the row rather than a cell. */
  field: string | null;
}

/**
 * The order "next blocker" walks: every row that still stops a commit, in the order the tables show
 * them, and within a row every cell its errors name, in column order. A row whose errors name no cell
 * is still visited once, so nothing that blocks a commit can be stepped past.
 */
export function importBlockerTargets(groups: readonly ImportTableGroup[]): ImportBlockerTarget[] {
  const targets: ImportBlockerTarget[] = [];
  for (const group of groups)
    for (const record of group.rows) {
      if (importRowStatus(record) !== "blocked") continue;
      const { byField } = importRowMessages({ ...record, warnings: [] }, group.columns);
      const named = group.columns.filter((column) => byField[column.name]?.length);
      if (named.length) for (const column of named) targets.push({ recordId: record.id, field: column.name });
      else targets.push({ recordId: record.id, field: null });
    }
  return targets;
}

/** Where the next or previous blocker is, wrapping at either end. -1 when the batch has none. */
export function stepBlockerIndex(count: number, current: number, step: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}
