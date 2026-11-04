// Copies the photo blob folder beside a database backup, add-only. Photos are kept indefinitely
//, so this never deletes, overwrites or prunes: a file the
// destination already holds under the same name is the same bytes, because blobs are named by the
// SHA-256 of their content.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

const HASH = /^[0-9a-f]{64}$/;

/** Every blob under `source` as `{hash, path}`; anything not named by a SHA-256 (temporary files) is skipped. */
export async function listBlobs(source) {
  const found = [];
  let fans;
  try {
    fans = await readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return found;
    throw error;
  }
  for (const fan of fans) {
    if (!fan.isDirectory() || !/^[0-9a-f]{2}$/.test(fan.name)) continue;
    for (const name of await readdir(join(source, fan.name))) {
      if (HASH.test(name) && name.startsWith(fan.name)) found.push({ hash: name, path: join(source, fan.name, name) });
    }
  }
  return found;
}

/**
 * Copies blobs missing from `destination`, add-only. Each copy goes to a temporary name, is checked for size
 * and renamed into place, so a crash mid-copy never leaves a truncated file under a real hash. A blob the
 * destination already holds is compared by size to the source and reported as `mismatched` if it differs,
 * never skipped silently or overwritten.
 */
export async function syncBlobs(source, destination) {
  let copied = 0;
  let present = 0;
  const mismatched = [];
  for (const blob of await listBlobs(source)) {
    const target = join(destination, blob.hash.slice(0, 2), blob.hash);
    const from = await stat(blob.path);
    const existing = await stat(target).catch(() => null);
    if (existing) {
      if (existing.size === from.size) present += 1;
      else mismatched.push(blob.hash);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await copyFile(blob.path, temporary);
    if ((await stat(temporary)).size !== from.size) {
      await rm(temporary, { force: true });
      mismatched.push(blob.hash);
      continue;
    }
    await rename(temporary, target);
    copied += 1;
  }
  return { copied, present, mismatched };
}
