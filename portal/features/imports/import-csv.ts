import type { ImportRecord } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import { absentField, explicitField } from "@/features/imports/import-validation";
import { normaliseImportDateText, stripBom, type ImportDateKind } from "@/features/imports/import-datetime";
import { headerDiagnostics, raggedRowDiagnostics } from "@/features/imports/import-diagnostics";
import { parseImportWeekdays } from "@/features/imports/import-weekdays";
import { sourceRelationships } from "@/features/imports/import-record-source";
import {
  importColumn,
  importSpecHeaders,
  importSpecs,
  type ImportColumnSpec,
  type ImportTabSpec
} from "@/features/imports/import-spec";

/**
 * `timezone` is the batch's zone: a timestamp written without an offset is read there rather than
 * wherever the machine parsing it happens to be. Left undefined the text is taken exactly as written.
 *
 * `diagnostics` is an array the caller may hand in to collect what the file as a whole says —
 * unknown headers, ragged rows. It is a sink rather than a second return value so that the many
 * callers who only want records are unaffected by asking about them.
 */
export function parseImportCsv(
  entity: string,
  text: string,
  startOrder = 0,
  timezone?: string,
  diagnostics?: string[]
): ImportRecord[] {
  const spec = importSpecs[entity];
  if (!spec) throw new Error(`Unsupported CSV entity: ${entity}`);
  // The row a cell sits on is the row the file numbers it as, blank and `#` lines included, so that
  // a validation message can be taken back to the spreadsheet the author is looking at.
  const rows = parseCsv(stripBom(text))
    .map((cells, index) => ({ cells, row: index + 1 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim()) && !cells[0]?.trim().startsWith("#"));
  if (rows.length < 1) throw new Error(`${entity}.csv has no header row.`);
  const headers = importHeaderNames(rows[0]!.cells);
  if (!headers.includes("import_key")) throw new Error(`${entity}.csv must include import_key.`);
  if (diagnostics)
    diagnostics.push(
      ...headerDiagnostics(spec.sheetName, headers, importSpecHeaders(spec)),
      ...raggedRowDiagnostics(spec.sheetName, headers.filter(Boolean).length, rows.slice(1))
    );
  return rows.slice(1).map(({ cells, row: rowNumber }, index) => {
    const row = Object.fromEntries(headers.map((header, column) => [header, cells[column]?.trim() ?? ""]));
    const fields: ImportRecord["fields"] = {};
    // A relation the spec carries as a field is read exactly as a column is, absence included, so a
    // key column the sheet left out leaves the stored key alone rather than clearing it. Read first,
    // so a record's fields come out in the order the template writes its headers.
    for (const relation of spec.relations)
      if (relation.asField)
        fields[relation.name] = headers.includes(relation.header)
          ? explicitField(row[relation.header] || null)
          : absentField();
    // A column the file does not carry is recorded as absent, not blank: on an update it leaves the
    // stored value alone, where a blank cell in a column that is there clears it.
    for (const column of spec.columns)
      fields[column.name] = headers.includes(column.header)
        ? explicitField(convertImportValue(row[column.header], column, timezone))
        : absentField();
    const relationships = {
      ...Object.fromEntries(
        spec.relations
          .filter((relation) => !relation.asField)
          .map((relation) => [relation.name, row[relation.header] || null])
      ),
      ...sourceRelationships(spec.sheetName, rowNumber)
    };
    return {
      id: createClientId(),
      importKey: row.import_key || `missing-${entity}-${index + 1}`,
      entityType: spec.type,
      operation: "create",
      expectedVersion: null,
      matchedEntityId: null,
      fields,
      relationships,
      errors: row.import_key ? [] : ["import_key is required."],
      warnings: [],
      removed: false,
      sortOrder: startOrder + index
    };
  });
}

/** The header row's names, lowercased and cleared of a byte-order mark Excel may have left on the first. */
export function importHeaderNames(cells: readonly string[]): string[] {
  return cells.map((cell) => stripBom(cell).trim().toLowerCase());
}

/** How a column's text is meant to be read as a date; every column the spec does not date-type is plain text. */
export function importCellKind(column: string, spec: ImportTabSpec): ImportDateKind {
  const kind = importColumn(spec, column)?.kind;
  return kind === "datetime" || kind === "date" || kind === "time" ? kind : "text";
}

/** Reads one cell's text as its column's kind says; a column the spec does not know is read as text. */
export function convertImportCell(
  value: string | undefined,
  column: string,
  spec: ImportTabSpec,
  timezone?: string
): unknown {
  return convertImportValue(value, importColumn(spec, column), timezone);
}

/**
 * The one reading of text into a field value, by column kind: what a CSV cell, a workbook cell, an
 * AI extraction and a value typed during review all go through. A number that is not a number, or a
 * boolean that is neither, is kept as the text it was so validation can say why.
 */
export function convertImportValue(
  value: string | undefined,
  column: ImportColumnSpec | undefined,
  timezone?: string
): unknown {
  if (!value) return null;
  switch (column?.kind) {
    case "number": {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    case "boolean":
      return ["true", "1", "yes"].includes(value.toLowerCase())
        ? true
        : ["false", "0", "no"].includes(value.toLowerCase())
          ? false
          : value;
    case "list":
      return value
        .split("|")
        .map((item) => item.trim())
        .filter(Boolean);
    case "weekdays":
      return parseImportWeekdays(value);
    case "pathwayGroups":
      return parsePathwayGroups(value);
    case "requirementPathways":
      return parsePathwayGroups(value).map((contextIds, index) => ({ id: `p${index + 1}`, contextIds }));
    case "datetime":
    case "date":
    case "time":
      return normaliseImportDateText(value, column.kind, timezone);
    default:
      return value;
  }
}

/**
 * `desktop+online | campus` -> [["desktop","online"],["campus"]]. OR across `|`, AND within `+`. A group
 * left empty by the author (e.g. `desktop | | campus`) is preserved as [] rather than dropped, so
 * validation can flag it explicitly instead of silently narrowing the requirement's alternatives.
 */
export function parsePathwayGroups(value: string): string[][] {
  return value.split("|").map((group) =>
    group
      .split("+")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted value.");
  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows;
}

/** The line every blank template opens with, so an unedited template cannot be uploaded as data. */
const CSV_TEMPLATE_INSTRUCTION =
  "# Remove this line before importing. Required fields must not be blank. Dates use ISO 8601.";

/** One entity's blank template: the instruction line, then its full header row. */
export function createImportCsvTemplate(spec: ImportTabSpec): string {
  return `${CSV_TEMPLATE_INSTRUCTION}\r\n${importSpecHeaders(spec).join(",")}\r\n`;
}
