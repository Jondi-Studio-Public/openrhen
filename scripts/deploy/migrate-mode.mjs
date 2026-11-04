/**
 * What the manual fallback tells the `migrate` service (`MIGRATE_ON_DEPLOY`). Kept apart from
 * deploy-home-server.mjs (which deploys on import) so the decision can be unit-tested.
 *
 * The fallback builds the working tree and tags every image `dev`, so the service cannot tell it from a local
 * run and needs to be told. Migrations are irreversible against the live database, so it applies them only
 * from a tree that is exactly what was merged: clean for everything that ships, and at origin/main. Anything
 * else (a feature branch, uncommitted edits, `--dirty`, a stale checkout, a fetch that failed) skips them,
 * unless the operator passes `--migrate` to say they mean it. An explicit `skip` in the shell or `.env`
 * (a rollback after a database restore) always wins; an `apply` there is not enough on its own.
 *
 * @param {{ configured?: string, migrateFlag: boolean, treeClean: boolean, atOriginMain: boolean }} input
 *   `configured` is MIGRATE_ON_DEPLOY from the shell or the workspace `.env`; `treeClean` is false under `--dirty`.
 * @returns {{ value: string, reason: string }}
 */
export function fallbackMigrateMode({ configured, migrateFlag, treeClean, atOriginMain }) {
  const set = (configured ?? "").trim().toLowerCase();
  if (set === "skip") return { value: "skip", reason: "MIGRATE_ON_DEPLOY=skip is set in the shell or .env" };
  if (set !== "" && set !== "apply") return { value: set, reason: `MIGRATE_ON_DEPLOY="${set.slice(0, 40)}" is set` };
  if (migrateFlag) return { value: "apply", reason: "--migrate was passed" };
  if (treeClean && atOriginMain) return { value: "apply", reason: "the tree is clean and at origin/main" };
  const why = !treeClean
    ? "the working tree has uncommitted changes that ship (or --dirty was passed)"
    : "HEAD is not origin/main (or origin/main could not be fetched)";
  return { value: "skip", reason: why };
}

/** The one line the fallback prints about the decision. */
export function migrateModeMessage({ value, reason }) {
  if (value === "apply") return `Migrations: will be applied (${reason}).`;
  if (value === "skip")
    return `Migrations NOT applied: ${reason}. Merge and deploy from a clean origin/main, or pass --migrate to apply them from this tree.`;
  return `Migrations: MIGRATE_ON_DEPLOY is "${value}" (${reason}); the migrate service will reject anything but apply or skip.`;
}
