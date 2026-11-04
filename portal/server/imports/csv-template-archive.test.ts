import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createImportCsvTemplate } from "@/features/imports/import-csv";
import { importCsvEntities, importSpecs } from "@/features/imports/import-spec";
import { createImportCsvTemplateArchive } from "./csv-template-archive";

describe("CSV template archive", () => {
  it("bundles every entity template, named as the single-entity downloads are", async () => {
    const zip = await JSZip.loadAsync(await createImportCsvTemplateArchive());
    expect(Object.keys(zip.files).sort()).toEqual(importCsvEntities.map((entity) => `openrhen-${entity}.csv`).sort());
  });

  it("archives the same bytes the single-entity route serves", async () => {
    const zip = await JSZip.loadAsync(await createImportCsvTemplateArchive());
    const actions = await zip.file("openrhen-actions.csv")!.async("string");
    expect(actions).toBe(createImportCsvTemplate(importSpecs.actions!));
    expect(actions.startsWith("# Remove this line before importing")).toBe(true);
  });
});
