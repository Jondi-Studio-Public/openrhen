import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { assertZipEntryCount, MAX_ZIP_ENTRIES, readZipEntryCapped } from "./zip-limits";

describe("zip limits", () => {
  it("reads entries under the cap and refuses ones that inflate past it", async () => {
    const zip = new JSZip();
    zip.file("small.txt", "hello");
    zip.file("bomb.bin", new Uint8Array(5 * 1024 * 1024), { compression: "DEFLATE" });
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    expect(new TextDecoder().decode(await readZipEntryCapped(loaded.file("small.txt")!, 100))).toBe("hello");
    await expect(readZipEntryCapped(loaded.file("bomb.bin")!, 1024 * 1024)).rejects.toThrow(/too large/);
  });

  it("refuses archives with too many entries", async () => {
    const zip = new JSZip();
    for (let i = 0; i <= MAX_ZIP_ENTRIES; i += 1) zip.file(`f${i}`, "");
    const loaded = await JSZip.loadAsync(await zip.generateAsync({ type: "uint8array" }));
    expect(() => assertZipEntryCount(loaded, "x.docx")).toThrow(/too many entries/);
  });
});
