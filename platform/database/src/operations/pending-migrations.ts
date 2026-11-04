import journal from "../../drizzle/meta/_journal.json" with { type: "json" };

type JournalEntry = { tag: string; when: number };
type Query = (strings: TemplateStringsArray) => PromiseLike<{ last: string | null }[]>;

/**
 * The migration tags the bundled journal lists that the database has not applied yet. Drizzle records each
 * applied migration's journal timestamp (`when`) in `drizzle.__drizzle_migrations.created_at`, and applies
 * them in order, so anything newer than the latest recorded one is pending. The deploy's `migrate` service runs them
 * (`migrate-on-deploy.ts` uses this to decide whether a dump and migration are due), and the health check
 * reports a schema that still lags the code.
 */
export async function pendingMigrationTags(sql: Query): Promise<string[]> {
  return pendingTagsAfter(await appliedMigrationTimestamp(sql));
}

/** The journal tags newer than `applied` (the newest recorded `created_at`, 0 when none). */
export function pendingTagsAfter(applied: number, entries: JournalEntry[] = journal.entries): string[] {
  return entries.filter((entry) => entry.when > applied).map((entry) => entry.tag);
}

/** The newest journal `when` this image carries (0 for an empty journal). */
export function imageNewestMigration(entries: JournalEntry[] = journal.entries): number {
  return entries.reduce((newest, entry) => Math.max(newest, entry.when), 0);
}

/**
 * Flyway-validate style: a database whose newest applied migration is newer than the newest one this image
 * knows is ahead of the image (a rollback by tag past a migration). Returns the refusal message, or null.
 * The doc section named in the message is the design notes
 */
export function schemaAheadProblem(applied: number, imageNewest: number): string | null {
  if (applied <= imageNewest) return null;
  return (
    `The database is ahead of this image: its newest applied migration (${applied}) is newer than the newest in this image's journal (${imageNewest}). ` +
    "Roll forward to a newer tag (the default), or restore the last pre-migrate dump taken before that migration " +
    "and deploy with MIGRATE_ON_DEPLOY=skip."
  );
}

/** The newest `created_at` drizzle recorded (0 when nothing is applied or the table does not exist yet). */
export async function appliedMigrationTimestamp(sql: Query): Promise<number> {
  let last = 0;
  try {
    const rows = await sql`SELECT max(created_at)::text AS last FROM drizzle.__drizzle_migrations`;
    last = Number(rows[0]?.last ?? 0);
  } catch (error) {
    // 42P01: the migrations table does not exist yet, so nothing has been applied.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "42P01") last = 0;
    else throw error;
  }
  return last;
}
