import { open, readdir, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";

/** The names `db:backup` writes. A `.partial` file never matches, so nothing else treats it as a backup. */
export const BACKUP_FILENAME = /^(?:priorities|openrhen)-.*\.json$/;

/**
 * Writes `contents` so the final name only ever appears complete: write to `<path>.partial`, fsync,
 * then rename. A kill or a full disk leaves a `.partial` file that `latestValidBackup` and pruning
 * ignore, instead of a truncated file under a real backup name (S8-10).
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const partial = `${path}.partial`;
  const handle = await open(partial, "wx");
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * The newest backup in `directory` that `load` accepts. A truncated or corrupt newest file is
 * skipped (and named in `skipped`) rather than failing a recovery that has an older good backup.
 */
export async function latestValidBackup<T>(
  directory: string,
  load: (text: string) => T
): Promise<{ path: string; backup: T; skipped: string[] }> {
  const names = (await readdir(directory))
    .filter((name) => BACKUP_FILENAME.test(name))
    .sort()
    .reverse();
  const skipped: string[] = [];
  for (const name of names) {
    const path = resolve(directory, name);
    try {
      return { path, backup: load(await readFile(path, "utf8")), skipped };
    } catch (error) {
      skipped.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    skipped.length
      ? `No valid OpenRhen backup in ${directory}; rejected ${skipped.join("; ")}`
      : `No OpenRhen backup found in ${directory}`
  );
}
