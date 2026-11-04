import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  decodeDeliverableSourceFile,
  DOCX_MIME,
  extractDocxImages,
  selectChatContextFiles
} from "./deliverable-source-file";

describe("deliverable source files", () => {
  it("accepts a PDF by extension when the browser supplies no MIME type", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nexample");
    const file = await decodeDeliverableSourceFile({
      filename: "brief.pdf",
      mimeType: "",
      dataUrl: dataUrl("", bytes)
    });
    expect(file).toMatchObject({ filename: "brief.pdf", mimeType: "application/pdf", bytes });
    expect(file.contentHash).toHaveLength(64);
  });

  it("rejects an extension or claimed MIME type that does not match the bytes", async () => {
    await expect(
      decodeDeliverableSourceFile({
        filename: "not-a-document.pdf",
        mimeType: "application/pdf",
        dataUrl: dataUrl("application/pdf", new TextEncoder().encode("hello"))
      })
    ).rejects.toThrow("not a valid PDF");
  });

  it("validates DOCX structure and exposes supported embedded images for visual inspection", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", "<Types />");
    zip.file("word/document.xml", "<w:document />");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    zip.file("word/media/image1.png", png);
    const bytes = await zip.generateAsync({ type: "uint8array" });
    const file = await decodeDeliverableSourceFile({
      filename: "assessment.docx",
      mimeType: DOCX_MIME,
      dataUrl: dataUrl(DOCX_MIME, bytes)
    });
    await expect(extractDocxImages(file)).resolves.toEqual([
      { filename: "assessment.docx:image1.png", mimeType: "image/png", bytes: png }
    ]);
  });
});

describe("chat context file budget", () => {
  const file = (filename: string, byteSize: number) => ({ filename, byteSize });

  it("keeps the oldest files that fit and names the rest so they can be spoken about honestly", () => {
    const result = selectChatContextFiles(
      [file("brief.pdf", 4_000), file("rubric.pdf", 4_000), file("late-photo.png", 4_000)],
      { maxFiles: 5, maxTotalBytes: 9_000 }
    );
    expect(result.included.map((item) => item.filename)).toEqual(["brief.pdf", "rubric.pdf"]);
    expect(result.omitted).toEqual(["late-photo.png"]);
  });

  it("caps the count as well as the bytes", () => {
    const files = Array.from({ length: 8 }, (_, index) => file(`page-${index}.png`, 10));
    const result = selectChatContextFiles(files, { maxFiles: 3, maxTotalBytes: 1_000_000 });
    expect(result.included).toHaveLength(3);
    expect(result.omitted).toHaveLength(5);
  });

  it("skips one oversized file without discarding the smaller ones behind it", () => {
    const result = selectChatContextFiles([file("huge.pdf", 90_000), file("brief.pdf", 500)], {
      maxFiles: 5,
      maxTotalBytes: 10_000
    });
    expect(result.included.map((item) => item.filename)).toEqual(["brief.pdf"]);
    expect(result.omitted).toEqual(["huge.pdf"]);
  });
});

function dataUrl(mimeType: string, bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mimeType};base64,${btoa(binary)}`;
}

describe("validateSignature", () => {
  it("rejects bytes that do not match the declared image type", async () => {
    const { validateSignature } = await import("./deliverable-source-file");
    await expect(validateSignature("a.png", "image/png", new TextEncoder().encode("<html>"))).rejects.toThrow(
      /valid PNG/
    );
    await expect(
      validateSignature("a.png", "image/png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ).resolves.toBeUndefined();
  });
});
