import type { ImportBatch } from "@openrhen/contracts";
import { importRecordSource } from "@/features/imports/import-record-source";

/**
 * A cell opening with `=`, `+`, `-`, `@`, tab or CR is read as a formula when the file is opened in a
 * spreadsheet, and imported text (titles, keys) is attacker-influenced. A leading apostrophe makes it
 * plain text; numbers pass through untouched.
 */
export function csvCell(value: unknown): string {
  const text = String(value);
  const safe = typeof value !== "number" && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/**
 * One row per error, not per record, so a record failing three checks explains all three. Each row
 * is addressed by the sheet and row it came from, so the report can be read beside the file that
 * produced it; a record no file produced leaves both columns blank.
 */
export function buildImportErrorCsv(batch: ImportBatch): string {
  const lines = [
    "sheet,row,entity_type,import_key,error",
    ...batch.records.flatMap((record) => {
      const { sheet, row } = importRecordSource(record);
      return record.errors.map((error) =>
        [sheet ?? "", row ?? "", record.entityType, record.importKey, error].map(csvCell).join(",")
      );
    })
  ];
  return lines.join("\r\n");
}

export function downloadImportErrors(batch: ImportBatch) {
  const url = URL.createObjectURL(new Blob([buildImportErrorCsv(batch)], { type: "text/csv" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `openrhen-import-${batch.id}-errors.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Started from a detached link rather than by navigating the page, so a download never disturbs the
 * view behind it.
 */
export function triggerDownload(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}
