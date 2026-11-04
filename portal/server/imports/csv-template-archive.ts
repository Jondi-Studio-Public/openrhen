import JSZip from "jszip";
import { createImportCsvTemplate } from "@/features/imports/import-csv";
import { importCsvEntities, importSpecs } from "@/features/imports/import-spec";

/**
 * Every entity's template in one archive, for the reason the XLSX template carries every sheet: a
 * plan that spans several entity types otherwise costs eleven separate downloads. Entries are named
 * exactly as the single-entity downloads are, so an unzipped folder and a set of files fetched one
 * at a time are the same thing to the uploader.
 *
 * It lives here rather than beside `createImportCsvTemplate` so that JSZip stays out of the module
 * the browser parser and the eleven plain CSV routes share — only this one download needs a zip.
 */
export async function createImportCsvTemplateArchive(): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const entity of importCsvEntities)
    zip.file(`openrhen-${entity}.csv`, createImportCsvTemplate(importSpecs[entity]!));
  return zip.generateAsync({ type: "uint8array" });
}
