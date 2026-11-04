/**
 * Refuses a database URL whose database name does not end in `_test`, the rule every integration suite
 * and `restore.ts` already follow. For scripts that write fake rows and stop real sessions, so a stray
 * `DATABASE_URL` from the workspace `.env` can never point them at the live database.
 */
export function assertTestDatabaseUrl(databaseUrl: string): void {
  let name: string;
  try {
    name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("DATABASE_URL is not a valid URL; refusing to run");
  }
  assertTestDatabaseName(name);
}

/** The same rule for a bare database name, for scripts that are given a name rather than a URL. */
export function assertTestDatabaseName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(name)) {
    throw new Error(`Refusing to run against database "${name}": its name must end in _test`);
  }
  // Postgres cuts an identifier, quoted or not, to 63 bytes, so a longer name would act on one without the suffix.
  if (name.length > POSTGRES_MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `Refusing to run against database "${name}": its name is over ${POSTGRES_MAX_IDENTIFIER_BYTES} characters, so Postgres would cut off its _test`
    );
  }
}

/** NAMEDATALEN - 1; the regex above allows only ASCII, so characters and bytes are the same count. */
const POSTGRES_MAX_IDENTIFIER_BYTES = 63;
