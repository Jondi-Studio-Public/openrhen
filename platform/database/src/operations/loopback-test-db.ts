/**
 * Integration tests create, migrate and drop databases and roles from POSTGRES_ADMIN_URL, and four
 * workers hold up to seventy connections. Pointed at the LAN Postgres that also serves live data, two
 * concurrent gates exhaust its connections and take the live portal, worker and backups down with
 * `too many clients already`. So the test cluster must be a throwaway on this machine
 * (`scripts/ci/start-postgres.sh`); a non-loopback host is refused unless ALLOW_LAN_TEST_DB=1.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * True for localhost, 127.0.0.0/8, ::1, and unix-socket hosts (an absolute path, or no host at all).
 * A URL with no host falls back to PGHOST in the driver, so that is checked in its place.
 */
export function isLoopbackDatabaseHost(connectionString: string, pgHost?: string): boolean {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return false;
  }
  const host = decodeURIComponent(url.hostname).toLowerCase();
  if (host === "") {
    // `postgresql:///db?host=/var/run/postgresql` names a socket directory; bare `postgresql:///db`
    // is the local socket default. A `host=` query naming a network host is not loopback.
    const queryHost = url.searchParams.get("host") ?? pgHost?.trim() ?? "";
    return queryHost === "" || queryHost.split(",").every(isLoopbackName);
  }
  return isLoopbackName(host);
}

function isLoopbackName(name: string): boolean {
  const host = name.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host) || host.startsWith("/");
}

/**
 * Throws when the integration admin URL is set but not loopback, unless ALLOW_LAN_TEST_DB=1.
 * An unset URL is left to the suites, which skip or fail with their own message.
 */
export function assertLoopbackTestDatabase(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ALLOW_LAN_TEST_DB === "1") return;
  for (const name of ["POSTGRES_ADMIN_URL", "DATABASE_URL"]) {
    const value = env[name];
    if (!value || isLoopbackDatabaseHost(value, env.PGHOST)) continue;
    let host = "an unparseable host";
    try {
      host = new URL(value).hostname || (env.PGHOST ? `${env.PGHOST} (from PGHOST)` : host);
    } catch {
      // keep the generic wording; never echo the URL, it carries credentials
    }
    throw new Error(
      `Refusing to run integration tests: ${name} points at ${host}, which is not this machine. ` +
        "Integration runs create and drop databases and hold up to seventy connections, which can " +
        "exhaust the live Postgres. Start a throwaway cluster instead " +
        '(Linux or WSL: eval "$(scripts/ci/start-postgres.sh)"; or rely on CI), ' +
        "or set ALLOW_LAN_TEST_DB=1 if you really mean a non-loopback test server."
    );
  }
}
