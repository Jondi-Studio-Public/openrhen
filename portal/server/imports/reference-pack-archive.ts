import JSZip from "jszip";
import {
  createReferencePackGuide,
  createReferencePackWorkbook,
  referencePackGuideFilename,
  referencePackWorkbookFilename,
  type ReferenceKeyMap,
  type ReferencePackMode,
  type ReferenceSelection
} from "./reference-pack";

/**
 * A pack as one file. Two downloads fired from one click are not handed to the user by the same
 * rules — a browser counts the second as automatic and writes it straight to the default folder
 * while the first honours "ask where to save each file" — and spacing them apart did not change
 * that. One file is the only arrangement a browser treats predictably, and it carries the property
 * the two modes exist for as a side effect: a guide cannot arrive without the workbook it describes,
 * or beside the workbook it contradicts.
 */
export async function createReferencePackArchive(
  selection: ReferenceSelection,
  keys: ReferenceKeyMap,
  mode: ReferencePackMode
): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    referencePackWorkbookFilename(selection.slug, mode),
    await createReferencePackWorkbook(selection, keys, mode)
  );
  zip.file(referencePackGuideFilename(selection.slug, mode), createReferencePackGuide(selection.scopeLabel, mode));
  return zip.generateAsync({ type: "uint8array" });
}
