import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { config } from "dotenv";
import { defineConfig } from "vitest/config";

const portalRoot = fileURLToPath(new URL(".", import.meta.url));

// Loaded here as well as in the global setup so `TEST_DATABASE_NAME` can decide parallelism below.
config({ path: resolve(portalRoot, "../.env"), quiet: true });

/**
 * Every suite provisions its own `<base>_<suffix>_test` database, so files can run side by side —
 * unless `TEST_DATABASE_NAME` pins the state-store family of suites to one exact database, in which
 * case they would truncate each other and must run one at a time.
 *
 * Four workers, raised from two on 2026-09-10. Know the budget before raising it again: a suite may
 * hold up to ten connections, so four workers is about seventy with one gate running. That is why the
 * test cluster must be a throwaway on this machine (`scripts/ci/start-postgres.sh`, max_connections
 * 200) and never the LAN Postgres, whose 100 connections the live services share: two gates there
 * overran it and presented as `too many clients already`. The global setup refuses a non-loopback
 * `POSTGRES_ADMIN_URL` unless `ALLOW_LAN_TEST_DB=1`.
 */
const pinnedToOneDatabase = Boolean(process.env.TEST_DATABASE_NAME);

export default defineConfig({
  resolve: { alias: { "@": portalRoot } },
  test: {
    environment: "node",
    // The suites were written for a deployment in a fixed non-UTC zone with DST and a day-first locale: `ensureUser` creates its user
    // from these when nothing is stored, as a real install does.
    //
    // The default Host allowlist is closed (loopback, `portal:8787`, the `PORTAL_PUBLIC_URL` host), and these suites send
    // `Host: portal.test`, so name it once here instead of in every file.
    env: {
      APP_TIMEZONE: "Australia/Sydney",
      APP_LOCALE: "en-AU",
      PORTAL_PUBLIC_URL: "https://portal.test"
    },
    include: ["server/**/*.integration.test.ts", "drop-ins/**/*.integration.test.ts"],
    globalSetup: ["./vitest-integration-global-setup.ts"],
    // Drops each file's database once the file finishes, so a run never holds them all at once.
    // The second file gives the suites the seed person they were written for (see its header).
    setupFiles: ["../platform/database/vitest-integration-file-cleanup.ts", "./test/persona-defaults.ts"],
    fileParallelism: !pinnedToOneDatabase,
    maxWorkers: Number(process.env.INTEGRATION_MAX_WORKERS) || 4,
    // Journeys drive the real engine and a LAN database (~4 ms per round trip, dozens of round trips
    // and two planning refreshes per store call); the longest take ~15 s alone and considerably more
    // when the machine is also building or testing something else. A timeout is not a finding.
    testTimeout: 120_000
  }
});
