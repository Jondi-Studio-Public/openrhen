/**
 * Pure helpers for the pre-migration dump that `migrate-on-deploy.ts` takes: the file name, and which
 * older dumps to delete. Kept free of I/O so they can be unit-tested.
 */

/** How many pre-migration dumps are kept; the one just taken counts. */
export const KEEP_PRE_MIGRATE_DUMPS = 5;

const DUMP_NAME = /^pre-migrate-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.dump$/;

/** `pre-migrate-<YYYYMMDDTHHMMSSZ>-<tag>.dump`; the tag is the image tag, `dev` when unset, and file-name safe. */
export function preMigrateDumpName(now: Date, imageTag: string | undefined): string {
  const stamp = now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
  const tag = (imageTag ?? "").replace(/[^A-Za-z0-9._-]/g, "-") || "dev";
  return `pre-migrate-${stamp}-${tag}.dump`;
}

/**
 * The dumps to delete so only the newest `keep` remain. Only names this module writes are considered, so
 * nothing else in the directory is ever touched. The UTC timestamp comes first in the name, so a plain
 * sort is chronological.
 */
export function preMigrateDumpsToPrune(names: readonly string[], keep = KEEP_PRE_MIGRATE_DUMPS): string[] {
  return names
    .filter((name) => DUMP_NAME.test(name))
    .sort()
    .reverse()
    .slice(keep);
}

/** A `.partial` dump older than this was abandoned (container killed mid-`pg_dump`); a live one is minutes old. */
export const STALE_PARTIAL_DUMP_MS = 6 * 60 * 60 * 1000;

const PARTIAL_NAME = /^pre-migrate-\d{8}T\d{6}Z-[A-Za-z0-9._-]+\.dump\.partial$/;

/** The abandoned partial dumps to delete: this module's `.partial` names whose mtime is older than `maxAgeMs`. */
export function stalePartialDumps(
  files: readonly { name: string; mtimeMs: number }[],
  nowMs: number,
  maxAgeMs = STALE_PARTIAL_DUMP_MS
): string[] {
  return files
    .filter((file) => PARTIAL_NAME.test(file.name) && nowMs - file.mtimeMs > maxAgeMs)
    .map((file) => file.name);
}
