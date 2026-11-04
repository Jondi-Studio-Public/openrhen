import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * The photo blob store: files named by the SHA-256 of their bytes, under a two-character fan-out folder, in
 * the folder `PHOTO_STORE_DIR` names. Content addressing makes a write
 * idempotent and lets backup copy the folder add-only. Photos never go in a database row, a log or git.
 */

const HASH = /^[0-9a-f]{64}$/;

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The path a hash lives at. Refuses anything that is not a SHA-256, so a hash can never name a path outside the store. */
export function blobPath(dir: string, hash: string): string {
  if (!HASH.test(hash)) throw new Error("Not a blob hash.");
  return join(dir, hash.slice(0, 2), hash);
}

/** Stores `bytes` and returns their hash. Writing the same bytes again changes nothing. */
export async function putBlob(dir: string, bytes: Uint8Array): Promise<string> {
  const hash = hashBytes(bytes);
  const target = blobPath(dir, hash);
  if (await exists(target)) return hash;
  await mkdir(dirname(target), { recursive: true });
  // Write beside the target and rename, so a crash never leaves a half-written file under a real hash.
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  return hash;
}

/** The bytes for a hash, or null when this store does not hold them (a restore without the folder). */
export async function getBlob(dir: string, hash: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(blobPath(dir, hash));
    return hashBytes(bytes) === hash ? bytes : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
