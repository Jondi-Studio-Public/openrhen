export type MigrateOnDeployMode = "apply" | "skip" | "local";

/** The hostname of the bundled Postgres service in a compose project; only reachable inside that project. */
export const BUNDLED_DATABASE_HOST = "postgres";

/** The tag the shared deploy workflow gives every image: the first 12 characters of the commit sha (`${sha::12}`). */
const CI_DEPLOY_TAG = /^[0-9a-f]{12}$/;

/**
 * Whether `migrate-on-deploy.ts` migrates. Only a deploy may: the CI deploy runs a 12-character commit-sha
 * `IMAGE_TAG`, and the manual fallback, whose images are tagged `dev`, sends `MIGRATE_ON_DEPLOY=apply` (only
 * from a clean tree at origin/main, or when told with `--migrate`). Any other tag, `dev` included, is `local`:
 * a local `compose --profile planning up` builds images against the workspace `.env`, whose `DATABASE_URL` is
 * the live database, so a developer's own tag must not migrate it. An unmerged branch's migration must never
 * reach production from a developer's machine.
 * The one exception to "any other tag is local" is a `DATABASE_URL` host of exactly `postgres`: the bundled
 * service, reachable only inside its own compose project, so a dev tag there cannot reach a live database and a
 * fresh install must migrate itself.
 * `MIGRATE_ON_DEPLOY=skip` is the explicit off switch, for a rollback to a tag older than the migrate service
 * after a database restore, where the newer migrate image (`MIGRATE_IMAGE_TAG`) would otherwise reapply the
 * migrations the restore just reversed. Any other value is an error, so a typo cannot silently decide.
 */
export function migrateOnDeployMode(
  value: string | undefined,
  imageTag: string | undefined,
  databaseHost?: string
): MigrateOnDeployMode {
  const mode = (value ?? "").trim().toLowerCase();
  if (mode === "skip" || mode === "apply") return mode;
  if (mode !== "") throw new Error(`MIGRATE_ON_DEPLOY must be unset, "apply" or "skip", not "${mode.slice(0, 40)}"`);
  if (databaseHost?.trim().toLowerCase() === BUNDLED_DATABASE_HOST) return "apply";
  return CI_DEPLOY_TAG.test((imageTag ?? "").trim()) ? "apply" : "local";
}
