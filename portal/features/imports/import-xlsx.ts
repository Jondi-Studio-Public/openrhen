import ExcelJS from "exceljs";
import { createClientId } from "@/shared/client-id";
import JSZip from "jszip";
import { assertZipEntryCount, MAX_ZIP_ENTRY_BYTES, readZipEntryCapped } from "@/features/imports/zip-limits";
import { DEFAULT_TIMEZONE, type ImportRecord } from "@openrhen/contracts";
import { convertImportValue, importCellKind, importHeaderNames } from "@/features/imports/import-csv";
import { excelDateCellText } from "@/features/imports/import-datetime";
import { headerDiagnostics, sheetDiagnostics } from "@/features/imports/import-diagnostics";
import { sourceRelationships } from "@/features/imports/import-record-source";
import {
  IMPORT_SHEET_NAMES,
  importColumnChoices,
  importCsvEntities,
  importSpecHeaders,
  importSpecs,
  type ImportTabSpec
} from "@/features/imports/import-spec";
import { absentField, explicitField } from "@/features/imports/import-validation";

const EXAMPLES: Record<string, Array<Record<string, string | number | boolean>>> = {
  areas: [
    { import_key: "study", name: "Study", description: "Coursework and learning", status: "active", sort_order: 0 }
  ],
  outcomes: [
    {
      import_key: "pass-course",
      area_key: "study",
      title: "Pass the course",
      definition_of_done: "Final result is a pass",
      value: 5,
      status: "active",
      review_on: "2026-09-01"
    }
  ],
  projects: [
    {
      import_key: "network-assignment",
      outcome_key: "pass-course",
      title: "Complete network assignment",
      status: "active",
      uncertainty: "some",
      consequence: 4,
      internal_deadline_at: "2026-08-20T17:00:00+10:00"
    }
  ],
  deliverables: [
    {
      import_key: "assessment-1",
      project_key: "network-assignment",
      title: "Assessment 1",
      details: "Deliverable shell; breakdown begins only when scheduled",
      status: "needs_breakdown",
      uncertainty: "some",
      importance: 4,
      consequence: 4,
      external_deadline_at: "2026-08-21T17:00:00+10:00"
    },
    {
      import_key: "assessment-2",
      project_key: "network-assignment",
      title: "Assessment 2",
      details: "Deliverable shell; no criteria or steps are imported",
      status: "needs_breakdown",
      uncertainty: "high",
      importance: 5,
      consequence: 5,
      external_deadline_at: "2026-08-28T17:00:00+10:00"
    }
  ],
  deliverable_dependencies: [
    { import_key: "assessment-2-after-1", deliverable_key: "assessment-2", depends_on_deliverable_key: "assessment-1" }
  ],
  actions: [
    {
      import_key: "research-section-1",
      project_key: "network-assignment",
      title: "Research section one",
      status: "planned",
      optimistic_minutes: 20,
      expected_minutes: 30,
      pessimistic_minutes: 45,
      remaining_minutes: 30,
      energy: "medium",
      minimum_session_minutes: 20,
      maximum_session_minutes: 45,
      splittable: true,
      setup_minutes: 5,
      importance: 4,
      consequence: 4,
      contexts: "laptop|home",
      requirements: "laptop+home",
      prefers: ""
    },
    {
      import_key: "draft-section-1",
      project_key: "network-assignment",
      title: "Draft section one",
      status: "planned",
      optimistic_minutes: 30,
      expected_minutes: 60,
      pessimistic_minutes: 90,
      remaining_minutes: 60,
      energy: "medium",
      minimum_session_minutes: 25,
      maximum_session_minutes: 60,
      splittable: true,
      setup_minutes: 5,
      importance: 4,
      consequence: 4,
      contexts: "laptop|home",
      requirements: "laptop+home",
      prefers: ""
    }
  ],
  dependencies: [
    { import_key: "draft-after-research", action_key: "draft-section-1", depends_on_action_key: "research-section-1" }
  ],
  fixed_commitments: [
    {
      import_key: "class-monday",
      title: "Class",
      starts_at: "2026-08-10T09:00:00+10:00",
      ends_at: "2026-08-10T11:00:00+10:00",
      status: "confirmed",
      setup_before_minutes: 10,
      transition_after_minutes: 15
    }
  ],
  fixed_commitment_recurrences: [
    {
      import_key: "piano-fortnightly",
      title: "Piano lesson",
      timezone: DEFAULT_TIMEZONE,
      start_date: "2026-08-14",
      end_date: "",
      interval_days: 14,
      local_start_time: "14:00",
      local_end_time: "15:00",
      location: "",
      setup_before_minutes: 10,
      transition_after_minutes: 15
    }
  ],
  conditions: [
    { import_key: "home", name: "Home", kind: "location", status: "active", grants: "desktop", travel_minutes: 0 },
    { import_key: "laptop", name: "Laptop", kind: "capability", status: "active", portability: "portable" }
  ]
};

export async function createImportWorkbook(): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "OpenRhen";
  workbook.created = new Date();
  const instructions = workbook.addWorksheet("Instructions", { views: [{ state: "frozen", ySplit: 1 }] });
  instructions.columns = [{ width: 24 }, { width: 92 }];
  instructions.addRow(["OpenRhen import", "Version 1"]);
  [
    [
      "How to use",
      "Fill the entity sheets, keep header names unchanged, then upload this workbook in Import Centre. Projects may contain actions, deliverable shells, or both."
    ],
    [
      "Deliverable shells",
      "Deliverables imports identity and planning metadata only. It never creates completion criteria, BCR steps, evidence, reviews, or sessions. Breakdown starts only when the engine recommends working on the deliverable and you open it."
    ],
    ["Stable keys", "Every row needs a unique import_key. Reusing an entity type and key previews an update."],
    ["Relationships", "Columns ending in _key refer to import_key values, not database IDs."],
    [
      "Missing values",
      "Leave unavailable optional values blank. Required blanks block commit until corrected or the row is removed."
    ],
    [
      "Dates",
      "ISO 8601 with an offset is exact, for example 2026-08-20T17:00:00+10:00. A date typed into a cell, or a timestamp without an offset, is read as your own timezone's clock."
    ],
    ["Lists", "Separate contexts with |, for example home|laptop."],
    ["Confirmation", "Import is atomic: no planning records are written if any active row has a blocker."],
    ["Limits", "Maximum 2,000 data rows and a 5 MB workbook."]
  ].forEach((row) => instructions.addRow(row));
  styleHeader(instructions.getRow(1));

  for (const entity of importCsvEntities) {
    const spec = importSpecs[entity]!;
    const headers = importSpecHeaders(spec);
    const sheet = workbook.addWorksheet(spec.sheetName, { views: [{ state: "frozen", ySplit: 1 }] });
    sheet.addRow(headers);
    for (const example of EXAMPLES[entity] ?? []) sheet.addRow(headers.map((header) => example[header] ?? ""));
    styleHeader(sheet.getRow(1));
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    headers.forEach((header, index) => {
      sheet.getColumn(index + 1).width = Math.min(42, Math.max(14, header.length + 3));
    });
    addColumnDropdowns(sheet, spec);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

const SPREADSHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/**
 * ExcelJS only matches unprefixed SpreadsheetML tags, so a workbook written with the main
 * namespace on a prefix (`<x:workbook>`, as the Open XML SDK and the tools built on it emit)
 * parses to an empty model and fails deep inside the loader. Rewriting those parts to carry
 * the namespace as the default lets the normal parser read them. Files that already use the
 * default namespace — Excel's own output — are returned untouched.
 */
async function normalizeSpreadsheetNamespace(data: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(data);
  assertZipEntryCount(zip, "Workbook");
  const workbookPart = zip.file("xl/workbook.xml");
  if (!workbookPart) return data;
  const prefix = new TextDecoder()
    .decode(await readZipEntryCapped(workbookPart, MAX_ZIP_ENTRY_BYTES, "Workbook part"))
    .match(new RegExp(`<([A-Za-z0-9_]+):workbook[\\s>][^>]*xmlns:\\1="${SPREADSHEET_NS}"`))?.[1];
  if (!prefix) return data;
  for (const part of Object.values(zip.files)) {
    if (part.dir || !/^xl\/.+\.xml$/.test(part.name)) continue;
    const xml = new TextDecoder().decode(await readZipEntryCapped(part, MAX_ZIP_ENTRY_BYTES, part.name));
    if (!xml.includes(`xmlns:${prefix}="${SPREADSHEET_NS}"`)) continue;
    zip.file(
      part.name,
      xml
        .replaceAll(`xmlns:${prefix}="${SPREADSHEET_NS}"`, `xmlns="${SPREADSHEET_NS}"`)
        .replaceAll(new RegExp(`<${prefix}:`, "g"), "<")
        .replaceAll(new RegExp(`</${prefix}:`, "g"), "</")
    );
  }
  return zip.generateAsync({ type: "arraybuffer" });
}

/**
 * `timezone` is the batch's zone. A workbook cannot carry an offset on a date cell, so the wall clock
 * Excel stored is resolved there; without one the reading is taken as UTC.
 *
 * `diagnostics` is an optional sink for what the workbook as a whole says — sheets nothing read,
 * headers no column matches — reported as warnings rather than returned, so that callers who only
 * want records need not change.
 */
export async function parseImportWorkbook(
  data: ArrayBuffer,
  timezone = DEFAULT_TIMEZONE,
  diagnostics?: string[]
): Promise<ImportRecord[]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await normalizeSpreadsheetNamespace(data));
  } catch (cause) {
    throw new Error(
      `This file could not be read as an XLSX workbook. Open it in Excel and use Save As to write a fresh .xlsx, then upload that. (${cause instanceof Error ? cause.message : String(cause)})`
    );
  }
  const records: ImportRecord[] = [];
  const readSheets: string[] = [];
  for (const entity of importCsvEntities) {
    const sheetName = IMPORT_SHEET_NAMES[entity]!;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;
    const spec = importSpecs[entity]!;
    const headers = importHeaderNames(rowValues(sheet.getRow(1)).map((value) => (value instanceof Date ? "" : value)));
    if (!headers.some(Boolean)) continue;
    if (!headers.includes("import_key")) throw new Error(`${sheetName} must include import_key.`);
    readSheets.push(sheet.name);
    if (diagnostics) diagnostics.push(...headerDiagnostics(sheetName, headers, importSpecHeaders(spec)));
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = rowValues(row);
      if (!values.some((value) => (value instanceof Date ? true : value.trim()))) return;
      const source = Object.fromEntries(
        headers.map((header, index) => [header, cellSourceText(values[index], header, spec, timezone)])
      );
      const fields: ImportRecord["fields"] = {};
      // As in the CSV parser: a column the sheet does not carry is absent, not blank, and a relation
      // the spec carries as a field is read the same way, in the order the template writes them.
      for (const relation of spec.relations)
        if (relation.asField)
          fields[relation.name] = headers.includes(relation.header)
            ? explicitField(source[relation.header] || null)
            : absentField();
      for (const column of spec.columns)
        fields[column.name] = headers.includes(column.header)
          ? explicitField(convertImportValue(source[column.header], column, timezone))
          : absentField();
      records.push({
        id: createClientId(),
        importKey: source.import_key || `missing-${entity}-${rowNumber - 1}`,
        entityType: spec.type,
        operation: "create",
        expectedVersion: null,
        matchedEntityId: null,
        fields,
        relationships: {
          ...Object.fromEntries(
            spec.relations
              .filter((relation) => !relation.asField)
              .map((relation) => [relation.name, source[relation.header] || null])
          ),
          ...sourceRelationships(sheetName, rowNumber)
        },
        errors: source.import_key ? [] : ["import_key is required."],
        warnings: [],
        removed: false,
        sortOrder: records.length
      });
    });
  }
  if (diagnostics)
    diagnostics.push(
      ...sheetDiagnostics(
        workbook.worksheets.map((sheet) => sheet.name),
        readSheets,
        Object.values(IMPORT_SHEET_NAMES)
      )
    );
  if (!records.length) throw new Error("The workbook contains no import records.");
  return records;
}

/**
 * Date cells are carried through as Dates rather than flattened to text here: what a date means
 * depends on the column it lands in, and the column is only known once the header row has been read.
 */
function rowValues(row: ExcelJS.Row): (string | Date)[] {
  const values: (string | Date)[] = [];
  for (let column = 1; column <= row.cellCount; column += 1) values.push(cellValue(row.getCell(column)));
  return values;
}

function cellValue(cell: ExcelJS.Cell): string | Date {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined)
      return value.result instanceof Date ? value.result : String(value.result);
    if ("text" in value) return String(value.text);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
  }
  return String(value);
}

function cellSourceText(value: string | Date | undefined, column: string, spec: ImportTabSpec, timezone: string) {
  if (value === undefined) return "";
  return value instanceof Date ? excelDateCellText(value, importCellKind(column, spec), timezone) : value.trim();
}

/**
 * A dropdown on every enum, boolean and suggested-value column, for the first 2,000 data rows. The
 * choices come from the column spec, so a template never offers a value validation would refuse.
 */
export function addColumnDropdowns(sheet: ExcelJS.Worksheet, spec: ImportTabSpec) {
  const headers = importSpecHeaders(spec);
  for (const column of spec.columns) {
    const choices = importColumnChoices(column);
    if (!choices) continue;
    const index = headers.indexOf(column.header) + 1;
    for (let row = 2; row <= 2001; row += 1)
      sheet.getCell(row, index).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [`"${choices.join(",")}"`]
      };
  }
}

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF20352F" } };
  row.alignment = { vertical: "middle" };
}
