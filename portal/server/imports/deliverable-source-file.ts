import JSZip from "jszip";
import { assertZipEntryCount, readZipEntryCapped } from "@/features/imports/zip-limits";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf", DOCX_MIME]);

export interface EncodedSourceFile {
  filename?: string;
  mimeType?: string;
  dataUrl?: string;
}
export interface RetainedSourceFile {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
  contentHash: string;
}

export async function decodeDeliverableSourceFile(file: EncodedSourceFile): Promise<RetainedSourceFile> {
  if (!file.filename?.trim() || file.filename.length > 255) throw new Error("Every file needs a valid filename.");
  const mimeType = normalizedMimeType(file.filename, file.mimeType);
  if (!mimeType || !MIME_TYPES.has(mimeType))
    throw new Error(`${file.filename} must be JPEG, PNG, WebP, PDF, or DOCX.`);
  const marker = ";base64,";
  const markerAt = file.dataUrl?.indexOf(marker) ?? -1;
  if (!file.dataUrl?.startsWith("data:") || markerAt < 5) throw new Error(`${file.filename} has invalid file data.`);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(file.dataUrl.slice(markerAt + marker.length)), (character) => character.charCodeAt(0));
  } catch {
    throw new Error(`${file.filename} has invalid base64 data.`);
  }
  const limit = mimeType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
  if (bytes.byteLength > limit) throw new Error(`${file.filename} must be ${limit / 1024 / 1024} MB or smaller.`);
  await validateSignature(file.filename, mimeType, bytes);
  return { filename: file.filename.trim(), mimeType, bytes, contentHash: await hash(bytes) };
}

/**
 * Chooses which retained files ride along with every deliverable chat turn.
 *
 * The Responses API is stateless with `store: false`, so whatever the conversation needs to see is
 * re-uploaded on each turn — a 5 MB brief is paid for again on turn twenty. Oldest first keeps the
 * selection stable as new files arrive (the brief that framed the conversation stays attached
 * rather than being pushed out by a screenshot), and anything past the budget is named so the
 * assistant can say a file is retained but not attached instead of inventing its contents.
 */
export function selectChatContextFiles<T extends { filename: string; byteSize: number }>(
  files: T[],
  limits: { maxFiles: number; maxTotalBytes: number }
): { included: T[]; omitted: string[] } {
  const included: T[] = [];
  const omitted: string[] = [];
  let total = 0;
  for (const file of files) {
    if (included.length < limits.maxFiles && total + file.byteSize <= limits.maxTotalBytes) {
      included.push(file);
      total += file.byteSize;
    } else omitted.push(file.filename);
  }
  return { included, omitted };
}

export async function extractDocxImages(file: RetainedSourceFile) {
  const zip = await JSZip.loadAsync(file.bytes);
  assertZipEntryCount(zip, file.filename);
  const images: Array<{ filename: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; bytes: Uint8Array }> =
    [];
  for (const entry of Object.values(zip.files)
    .filter((item) => !item.dir && item.name.startsWith("word/media/"))
    .slice(0, 10)) {
    const extension = entry.name.split(".").pop()?.toLowerCase();
    const mimeType =
      extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : null;
    if (!mimeType) continue;
    const bytes = await readZipEntryCapped(entry, MAX_IMAGE_BYTES, entry.name).catch(() => null);
    if (bytes) images.push({ filename: `${file.filename}:${entry.name.split("/").pop()}`, mimeType, bytes });
  }
  return images;
}

function normalizedMimeType(filename: string, supplied?: string) {
  if (supplied && supplied !== "application/octet-stream") return supplied.toLowerCase();
  const extension = filename.split(".").pop()?.toLowerCase();
  return extension === "pdf"
    ? "application/pdf"
    : extension === "docx"
      ? DOCX_MIME
      : extension === "jpg" || extension === "jpeg"
        ? "image/jpeg"
        : extension === "png"
          ? "image/png"
          : extension === "webp"
            ? "image/webp"
            : supplied;
}

export async function validateSignature(filename: string, mimeType: string, bytes: Uint8Array) {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg" && !starts(0xff, 0xd8, 0xff)) throw new Error(`${filename} is not a valid JPEG file.`);
  if (mimeType === "image/png" && !starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    throw new Error(`${filename} is not a valid PNG file.`);
  if (
    mimeType === "image/webp" &&
    !(starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP")
  )
    throw new Error(`${filename} is not a valid WebP file.`);
  if (mimeType === "application/pdf" && String.fromCharCode(...bytes.slice(0, 5)) !== "%PDF-")
    throw new Error(`${filename} is not a valid PDF file.`);
  if (mimeType === DOCX_MIME) {
    if (!starts(0x50, 0x4b)) throw new Error(`${filename} is not a valid DOCX file.`);
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new Error(`${filename} is not a valid DOCX file.`);
    }
    assertZipEntryCount(zip, filename);
    if (!zip.file("[Content_Types].xml") || !zip.file("word/document.xml"))
      throw new Error(`${filename} is not a valid DOCX file.`);
  }
}

async function hash(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
