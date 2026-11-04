import { access } from "node:fs/promises";
import { join } from "node:path";

const HASH = /^[0-9a-f]{64}$/;

/** The hashes a restored database points at: every original, working copy and place reference photo. */
export function referencedBlobHashes(restored: {
  photo_checkin?: readonly Record<string, unknown>[];
  place_reference_photo?: readonly Record<string, unknown>[];
}): string[] {
  const hashes = new Set<string>();
  for (const row of restored.photo_checkin ?? []) {
    for (const column of ["original_hash", "working_hash"]) {
      const value = row[column];
      if (typeof value === "string") hashes.add(value);
    }
  }
  for (const row of restored.place_reference_photo ?? []) {
    const value = row.blob_hash;
    if (typeof value === "string") hashes.add(value);
  }
  return [...hashes].sort();
}

/**
 * The hashes with no file under `dir`, using the blob store's own layout (a two-character fan-out folder, then
 * the SHA-256). A value that is not a SHA-256 counts as missing rather than being joined into a path.
 */
export async function missingBlobHashes(dir: string, hashes: readonly string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const hash of hashes) {
    if (!HASH.test(hash)) {
      missing.push(hash);
      continue;
    }
    try {
      await access(join(dir, hash.slice(0, 2), hash));
    } catch {
      missing.push(hash);
    }
  }
  return missing;
}
