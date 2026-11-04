import type { ImportRecord } from "@openrhen/contracts";

/**
 * Where a record was read from: the sheet or CSV tab it sat on, and the row the file numbers it as.
 * It travels in `relationships` under underscore-prefixed names rather than in a column of its own,
 * because relationships are stored as JSON and handed back unchanged, so a row keeps its address
 * across a draft save without a schema change — and a relationship name the importer does not know
 * is ignored everywhere keys are resolved. The review screen hides these names from the editable
 * relationships; the record card and the error CSV read them back.
 */
export const SOURCE_SHEET = "_sourceSheet";
export const SOURCE_ROW = "_sourceRow";

export interface ImportRecordSource {
  sheet: string | null;
  row: number | null;
}

/** What a parser attaches to a record so the row it came from can be named later. */
export function sourceRelationships(sheet: string, row: number): Record<string, string> {
  return { [SOURCE_SHEET]: sheet, [SOURCE_ROW]: String(row) };
}

/** Names the screen manages itself and never offers as a text box. */
export const isInternalRelationship = (name: string) => name.startsWith("_");

export function importRecordSource(record: Pick<ImportRecord, "relationships">): ImportRecordSource {
  const row = Number(record.relationships[SOURCE_ROW]);
  return {
    sheet: record.relationships[SOURCE_SHEET] || null,
    row: Number.isInteger(row) && row > 0 ? row : null
  };
}

/** "Row 14 · Actions", or null for a record no file produced — an AI extraction or a calendar event. */
export function describeImportRecordSource(record: Pick<ImportRecord, "relationships">): string | null {
  const { sheet, row } = importRecordSource(record);
  if (row === null) return sheet;
  return sheet ? `Row ${row} · ${sheet}` : `Row ${row}`;
}
