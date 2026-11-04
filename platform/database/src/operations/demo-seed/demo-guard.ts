import { assertTestDatabaseUrl } from "../test-database-guard.js";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
/** IPv4 literals on a private network (RFC 1918), where the workspace's shared Postgres lives. */
const PRIVATE_IPV4 = /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/;

/** Throws unless the URL points at this machine: the demo seed writes fake data and must never reach a live server. */
export function assertLocalUrl(rawUrl: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${what} is not a valid URL; refusing to seed`);
  }
  if (!LOCAL_HOSTS.has(parsed.hostname))
    throw new Error(`Refusing to seed: ${what} points at ${parsed.hostname}, not localhost`);
  return parsed;
}

/**
 * The database the seed writes: one on this machine, or a `_test` database on the LAN Postgres, where
 * the integration suites and the production smoke make theirs (the live database is never `_test`).
 */
export function assertSeedDatabaseUrl(rawUrl: string, what: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${what} is not a valid URL; refusing to seed`);
  }
  if (LOCAL_HOSTS.has(parsed.hostname)) return parsed;
  if (!PRIVATE_IPV4.test(parsed.hostname))
    throw new Error(`Refusing to seed: ${what} points at ${parsed.hostname}, not localhost or the LAN`);
  try {
    assertTestDatabaseUrl(rawUrl);
  } catch {
    throw new Error(
      `Refusing to seed: ${what} is on ${parsed.hostname}, and only a _test database there may be seeded`
    );
  }
  return parsed;
}
