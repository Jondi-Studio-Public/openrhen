import postgres from "postgres";

/**
 * Integration databases are isolated per run. Unless a suite's env var pins an exact name, every
 * suite derives `<base>_<suffix>_test`, where the suffix is minted once per vitest run (in that
 * run's globalSetup, before workers fork) and the run's databases are dropped again in teardown.
 * Two runs can therefore execute at the same time without truncating each other's tables — which
 * is what happened when the names were fixed. Pinning the env var restores the old behaviour —
 * one exact database, created if missing, reused across runs, never dropped — for inspecting
 * state after a failure.
 *
 * Every suite also uses a different base, so the files of one run can execute in parallel.
 */
const SUFFIX_PATTERN = /^[a-z][a-z0-9]*$/;

/** Set by ensureIntegrationDbSuffix in the environment workers inherit, so a test file knows the run owns cleanup. */
const MINTED_FLAG = "INTEGRATION_DB_SUFFIX_MINTED";

/**
 * The run-suffixed names this worker has handed out since its last per-file cleanup. On globalThis,
 * not in module scope, so the cleanup setup file sees the same set whichever import path a suite
 * used to reach this module.
 */
const tracked: Set<string> = ((
  globalThis as { __openrhenIntegrationNames?: Set<string> }
).__openrhenIntegrationNames ??= new Set<string>());

export function integrationDatabaseName(pinned: string | undefined, base: string): string {
  if (pinned) return pinned;
  const suffix = process.env.INTEGRATION_DB_SUFFIX;
  if (!suffix) return `${base}_test`;
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new Error("INTEGRATION_DB_SUFFIX must be lowercase letters and digits, starting with a letter");
  }
  const name = `${base}_${suffix}_test`;
  if (process.env[MINTED_FLAG] === suffix) tracked.add(name);
  return name;
}

/**
 * A cluster-wide LOGIN role a suite creates for itself, named the same way as its database so it
 * is private to the run and dropped with the run's databases. Roles belong to the Postgres server,
 * not to a database, so a fixed name would be shared by every concurrent run.
 */
export function integrationRoleName(pinned: string | undefined, base: string): string {
  return integrationDatabaseName(pinned, base);
}

/**
 * Mint the per-run suffix if none was provided, before test workers fork so they inherit it.
 * Returns the minted suffix, or null when one was already present — the caller owns cleanup
 * only for a suffix it minted itself.
 */
export function ensureIntegrationDbSuffix(): string | null {
  if (process.env.INTEGRATION_DB_SUFFIX) return null;
  const suffix = `r${process.pid.toString(36)}${Date.now().toString(36)}`;
  process.env.INTEGRATION_DB_SUFFIX = suffix;
  process.env[MINTED_FLAG] = suffix;
  return suffix;
}

/** The names tracked since the last call, emptying the set. */
export function takeTrackedIntegrationNames(): string[] {
  const names = [...tracked].filter((name) => /^[A-Za-z0-9_]+_test$/.test(name));
  tracked.clear();
  return names;
}

/**
 * Drop the databases, then the roles, that this worker's suites named since the last call, and
 * forget them. Run after each test file (`integration-file-cleanup.ts`), so a run holds only the
 * databases of the files in flight rather than every file's: about 13 MB each once migrated, which
 * across a full run is well over a gigabyte, more than a Mac runner's RAM disk has room for. Only
 * names minted for this run are tracked, so a pinned name or a caller's suffix is never dropped
 * here. Best effort: anything left is dropped by the run's teardown.
 */
export async function dropTrackedIntegrationDatabases(adminUrl: string): Promise<string[]> {
  const names = takeTrackedIntegrationNames();
  if (names.length === 0) return [];
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10, onnotice: () => {} });
  const dropped: string[] = [];
  try {
    for (const name of names) {
      const existing = await admin<{ datname: string }[]>`SELECT datname FROM pg_database WHERE datname = ${name}`;
      if (existing.length === 0) continue;
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      dropped.push(name);
    }
    for (const name of names) {
      const existing = await admin<{ rolname: string }[]>`SELECT rolname FROM pg_roles WHERE rolname = ${name}`;
      if (existing.length === 0) continue;
      try {
        await admin.unsafe(`DROP ROLE IF EXISTS "${name}"`);
        dropped.push(name);
      } catch {
        // Still holds privileges in a database another file owns; the run's teardown drops it.
      }
    }
    return dropped;
  } finally {
    await admin.end();
  }
}

/**
 * Drop every database, and then every role, this run's suffix produced. Roles go second because a
 * role cannot be dropped while it still holds privileges in an existing database. Returns the
 * names dropped.
 */
export async function dropIntegrationDatabases(adminUrl: string, suffix: string): Promise<string[]> {
  if (!SUFFIX_PATTERN.test(suffix)) {
    throw new Error("Refusing to drop databases for a suffix that is not lowercase letters and digits");
  }
  const admin = postgres(adminUrl, { max: 1, connect_timeout: 10 });
  try {
    const pattern = `%\\_${suffix}\\_test`;
    const databases = await admin<{ datname: string }[]>`
      SELECT datname FROM pg_database WHERE datname LIKE ${pattern}
    `;
    for (const row of databases) {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    }
    const roles = await admin<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname LIKE ${pattern}
    `;
    for (const row of roles) {
      await admin.unsafe(`DROP ROLE IF EXISTS "${row.rolname}"`);
    }
    return [...databases.map((row) => row.datname), ...roles.map((row) => row.rolname)];
  } finally {
    await admin.end();
  }
}
