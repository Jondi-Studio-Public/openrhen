import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { createSeedState } from "@/state/portal-state";
import {
  fallbackReferenceKey,
  referenceKeyCandidates,
  referencePackArchiveFilename,
  referencePackGuideFilename,
  referencePackWorkbookFilename,
  selectReferencePack,
  type ReferenceKeyMap
} from "./reference-pack";
import { createReferencePackArchive } from "./reference-pack-archive";

const state = createSeedState(new Date("2026-08-10T09:00:00+10:00"));

function keyMap(selection: ReturnType<typeof selectReferencePack>): ReferenceKeyMap {
  const keys: ReferenceKeyMap = {};
  for (const candidate of referenceKeyCandidates(selection)) {
    keys[candidate.entityType] ??= {};
    keys[candidate.entityType]![candidate.entityId] = fallbackReferenceKey(candidate);
  }
  return keys;
}

describe("reference pack archive", () => {
  it("holds exactly the workbook and the guide, under the names each downloads by", async () => {
    const selection = selectReferencePack(state, [{ type: "all" }]);
    for (const mode of ["add", "roundtrip"] as const) {
      const zip = await JSZip.loadAsync(await createReferencePackArchive(selection, keyMap(selection), mode));
      expect(Object.keys(zip.files).sort()).toEqual(
        [referencePackWorkbookFilename(selection.slug, mode), referencePackGuideFilename(selection.slug, mode)].sort()
      );
    }
  });

  it("archives a workbook that still opens, and the guide written for that mode", async () => {
    const selection = selectReferencePack(state, [{ type: "all" }]);
    const zip = await JSZip.loadAsync(await createReferencePackArchive(selection, keyMap(selection), "roundtrip"));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      await zip.file(referencePackWorkbookFilename(selection.slug, "roundtrip"))!.async("arraybuffer")
    );
    expect(workbook.getWorksheet("Instructions")).toBeDefined();
    expect(workbook.getWorksheet("Reference Actions")).toBeDefined();

    const guide = await zip.file(referencePackGuideFilename(selection.slug, "roundtrip"))!.async("string");
    expect(guide).toContain("# OpenRhen editing pack instructions for external tools");
    expect(guide).toContain("This is an editing pack, not an add-only pack");
  });

  it("names the archive as its pack, so add-only and editing never collide in a downloads folder", () => {
    expect(referencePackArchiveFilename("entire-plan", "add")).toBe("openrhen-reference-entire-plan.zip");
    expect(referencePackArchiveFilename("entire-plan", "roundtrip")).toBe("openrhen-roundtrip-entire-plan.zip");
  });
});
