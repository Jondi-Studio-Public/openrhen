import type { ImportRecord } from "@openrhen/contracts";
import { importHeaderNames, parseImportCsv } from "@/features/imports/import-csv";
import { stripBom } from "@/features/imports/import-datetime";
import { importCsvEntities, importTemplateHeaders } from "@/features/imports/import-spec";
import { sha256Hex } from "@/shared/sha256";

/**
 * The limits the import screen enforces before anything is uploaded. They are checked in the browser
 * so a mistyped file or an oversized paste is refused instantly, and again on the server, which is
 * the boundary that actually decides.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export const isWorkbookFile = (file: { name: string }) => file.name.toLowerCase().endsWith(".xlsx");

/** The first problem with a workbook or CSV selection, or null when it can be previewed. */
export function validateImportFileSelection(files: readonly { name: string; size: number }[]): string | null {
  if (files.reduce((sum, file) => sum + file.size, 0) > MAX_IMPORT_BYTES)
    return "Workbook or combined CSV input must be 5 MB or smaller.";
  if (files.some((file) => !/\.(csv|xlsx)$/i.test(file.name))) return "Select an XLSX workbook or CSV templates.";
  if (files.some(isWorkbookFile) && files.length !== 1)
    return "Upload one XLSX workbook, or one or more CSV files—not both in the same batch.";
  return null;
}

/** The first problem with a text or image extraction request, or null when it can be sent. */
export function validateAiIntake(text: string, images: readonly { type: string; size: number }[]): string | null {
  if (!text.trim() && !images.length) return "Paste text or select at least one image.";
  if (text.length > 100000) return "Text input must be 100,000 characters or fewer.";
  if (images.length > 5) return "Upload at most five images.";
  if (images.some((file) => !IMAGE_TYPES.includes(file.type))) return "Images must be JPEG, PNG, or WebP.";
  if (
    images.some((file) => file.size > MAX_IMAGE_BYTES) ||
    images.reduce((sum, file) => sum + file.size, 0) > MAX_IMAGE_TOTAL_BYTES
  )
    return "Each image must be at most 8 MB and all images together at most 20 MB.";
  return null;
}

/** `OpenRhen-Actions - Copy (1).csv` -> `openrhen-actions-copy-1`: one token per run of letters or digits. */
const filenameTokens = (filename: string) =>
  filename
    .toLowerCase()
    .replace(/\.csv$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Which entity a CSV holds. The filename is read as tokens rather than as a suffix, so the copies and
 * renames a browser or a person makes — `openrhen-actions (1).csv`, `Actions - Copy.csv`,
 * `actions-week2.csv` — still name their entity. When the name says nothing the header row decides,
 * which is the stronger signal anyway: it is what the file actually contains. Returns null when
 * neither can tell.
 */
export function detectCsvEntity(filename: string, text?: string): string | null {
  const tokens = filenameTokens(filename);
  const named = importCsvEntities
    .filter((entity) => new RegExp(`(^|-)${filenameTokens(entity)}(-|$)`).test(tokens))
    // `deliverable_dependencies` contains `dependencies`; the longer name is the one the author meant.
    .sort((first, second) => second.length - first.length)[0];
  return named ?? (text === undefined ? null : sniffCsvEntity(text));
}

/** The entity whose template headers the file's own header row matches most closely. */
function sniffCsvEntity(text: string): string | null {
  const headers = new Set(csvHeaderRow(text));
  if (!headers.has("import_key")) return null;
  let best: { entity: string; score: number } | null = null;
  for (const entity of importCsvEntities) {
    const template = importTemplateHeaders(entity);
    const matched = template.filter((header) => headers.has(header)).length;
    const union = new Set([...template, ...headers]).size;
    const score = union ? matched / union : 0;
    if (matched > 1 && (!best || score > best.score)) best = { entity, score };
  }
  return best?.entity ?? null;
}

/** The first row that is neither blank nor one of the template's `#` instruction lines. */
function csvHeaderRow(text: string): string[] {
  const line = stripBom(text)
    .split(/\r\n|\n|\r/)
    .find((row) => row.trim() && !row.trim().startsWith("#"));
  return line ? importHeaderNames(line.split(",").map((cell) => cell.replace(/^"|"$/g, ""))) : [];
}

/**
 * Identifies the content a batch came from, so uploading the same file again is recognised as the
 * same batch. It is a SHA-256 over the bytes of the selected files — sorted by name so a multi-CSV
 * selection hashes the same whatever order the picker handed them over, each file's length written
 * ahead of its bytes so two files cannot be confused with one — and nothing else: a re-saved copy of
 * an identical file, or the same file under a new name, is the same content and gets the same hash.
 */
export async function hashImportSource(files: readonly { name: string; bytes: ArrayBuffer }[]): Promise<string> {
  const ordered = [...files].sort((first, second) => first.name.localeCompare(second.name));
  const total = ordered.reduce((sum, file) => sum + 4 + file.bytes.byteLength, 0);
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  for (const file of ordered) {
    view.setUint32(offset, file.bytes.byteLength);
    buffer.set(new Uint8Array(file.bytes), offset + 4);
    offset += 4 + file.bytes.byteLength;
  }
  return sha256Hex(buffer);
}

/** What a workbook or CSV selection becomes before it is sent for preview. */
export interface ParsedImportFiles {
  sourceType: "csv" | "xlsx";
  records: ImportRecord[];
  source: { filename: string; mimeType: string; contentHash: string };
  /** What the files as a whole gave up: ignored columns and sheets, rows wider than their header. */
  diagnostics: string[];
}

/**
 * Reads a selection the screen has already checked (`validateImportFileSelection`): one workbook, or
 * one CSV per entity, each read as the batch's timezone says. The workbook reader is loaded on
 * demand because it pulls in ExcelJS, which nothing else on the page needs.
 */
export async function parseImportFiles(
  files: readonly { name: string; bytes: ArrayBuffer }[],
  timezone: string
): Promise<ParsedImportFiles> {
  const workbook = files.some(isWorkbookFile);
  const diagnostics: string[] = [];
  let records: ImportRecord[] = [];
  if (workbook) {
    const { parseImportWorkbook } = await import("@/features/imports/import-xlsx");
    records = await parseImportWorkbook(files[0]!.bytes, timezone, diagnostics);
  } else
    for (const file of files) {
      const text = new TextDecoder().decode(file.bytes);
      const entity = detectCsvEntity(file.name, text);
      if (!entity)
        throw new Error(
          `Cannot determine entity type from ${file.name}. Use a downloaded template filename, or keep the template's header row.`
        );
      records = [...records, ...parseImportCsv(entity, text, records.length, timezone, diagnostics)];
    }
  if (records.length > 2000) throw new Error("A batch can contain at most 2,000 records.");
  return {
    sourceType: workbook ? "xlsx" : "csv",
    records,
    source: {
      filename: files.map((file) => file.name).join(", "),
      mimeType: workbook ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "text/csv",
      contentHash: await hashImportSource(files)
    },
    diagnostics
  };
}

export function fileDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string" ? resolve(reader.result) : reject(new Error(`Could not read ${file.name}.`));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}
