import { stat, statfs } from "node:fs/promises";
import { resolve } from "node:path";

/** The file the owner creates at the root of the NAS share. Its presence proves the share is mounted. */
export const TARGET_SENTINEL = ".openrhen-backup-target";
// A floor in bytes, not a percentage: the NAS pool runs near 85% full, and a percentage floor would stop every copy
// there while a few GB is plenty. The floor grows with the backup so a large one still has room for several copies.
export const MIN_FREE_BYTES = 5 * 1024 ** 3;
export const BACKUP_SIZE_MULTIPLE = 3;

/**
 * Refuses to copy into a directory that is not the real off-machine target. Without the sentinel, an unmounted
 * share is just an empty folder on this server's own disk, and "copying" there would look like protection. A
 * target with less than max(5 GB, 3 x the backup) free fails too, so the copy stops before it can fill and fail halfway.
 */
export async function assertBackupTarget(directory, { backupBytes = 0, statfsImpl = statfs } = {}) {
  const sentinel = resolve(directory, TARGET_SENTINEL);
  const present = await stat(sentinel).then(
    (entry) => entry.isFile(),
    () => false
  );
  if (!present)
    throw new Error(
      `${TARGET_SENTINEL} is missing from ${directory}; the backup share is probably not mounted. ` +
        "Mount it, or create that file at the root of the share if this really is the right folder."
    );
  const fs = await statfsImpl(directory);
  const free = Number(fs.bavail) * Number(fs.bsize);
  const needed = Math.max(MIN_FREE_BYTES, BACKUP_SIZE_MULTIPLE * backupBytes);
  if (free < needed)
    throw new Error(
      `${directory} has ${(free / 1024 ** 3).toFixed(1)} GB free; ` +
        `copying needs at least ${(needed / 1024 ** 3).toFixed(1)} GB (5 GB, or 3 times the backup if larger).`
    );
  return { freeBytes: free, neededBytes: needed };
}
