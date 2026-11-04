// Shared boot helpers for the production smoke's phases (scripts/smoke/production-click.mjs runs the
// click phase and then the demo-seed phase in scripts/smoke/seed-phase.mjs).
//
// What lives here is what both phases need to bring the built portal up against a database and to
// leave nothing behind: finding the admin connection, creating, migrating and dropping a `_test`
// database, starting the portal (and other servers) in their own process groups, waiting for them to
// answer, and shutting them down on every way out, including a cancelled CI job. Nothing in this file
// runs at import; `installProcessHandlers()` is the one call that takes over SIGINT, SIGTERM and exit.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const IS_WIN = process.platform === "win32";
export const PNPM = IS_WIN ? "pnpm.cmd" : "pnpm";
export const PNPM_OPTS = IS_WIN ? { shell: true } : {};
export const READY_TIMEOUT_MS = 60_000;

export class SmokeFailure extends Error {}

export function log(message) {
  console.log(`[smoke] ${message}`);
}

export function fail(message) {
  throw new SmokeFailure(message);
}

export function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// What a cancelled run has to clean up. Servers are spawned detached (each its own process group) so a
// normal finish can kill pnpm, its shell and the node server together, but that also means a CI
// cancel, which signals this script and nothing else, would leave them listening. These are read by
// the signal handlers and the exit backstop in `installProcessHandlers`.
const detachedChildren = new Set();
const foregroundChildren = new Set();
const exitCleanups = [];
let activeBrowser = null;

/** The browser a phase has open, so a signal can close it. Pass null once it is closed. */
export function setActiveBrowser(browser) {
  activeBrowser = browser;
}

/**
 * Registers a synchronous cleanup that runs once, on a signal or on exit, whichever comes first
 * (`exit` handlers can do nothing asynchronous). Returns a function that runs it now, idempotently, for
 * the normal path.
 */
export function registerCleanup(cleanup) {
  let done = false;
  const runOnce = () => {
    if (done) return;
    done = true;
    try {
      cleanup();
    } catch (error) {
      console.error(`[smoke] cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  exitCleanups.push(runOnce);
  return runOnce;
}

/**
 * Minimal KEY=VALUE reader — enough for the handful of vars this script needs from the workspace
 * .env, without adding `dotenv` as a root dependency just for that. Like dotenv, a value already in
 * `process.env` wins over the file.
 */
export function parseEnvFile(path) {
  const values = {};
  if (!existsSync(path)) return values;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function envVar(dotenv, name) {
  return process.env[name]?.trim() || dotenv[name]?.trim();
}

/** `adminUrl` with its database swapped for `databaseName`. */
export function databaseUrlFor(adminUrl, databaseName) {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * The same database the portal's own PostgreSQL integration tests default to (see
 * the design notes): POSTGRES_ADMIN_URL from .env with the database name
 * swapped for TEST_DATABASE_NAME, or `<TARGET_DATABASE_NAME>_test` (normally `openrhen_test`) when
 * that is unset. Built independently of DATABASE_URL, so the live database is never in the picture.
 * `adminUrl` comes back too, for a phase that makes a database of its own on the same server.
 */
export function resolveTestDatabaseUrl() {
  const dotenv = parseEnvFile(resolve(ROOT, ".env"));
  const adminUrl = envVar(dotenv, "POSTGRES_ADMIN_URL");
  if (!adminUrl) fail("POSTGRES_ADMIN_URL is not set (checked the environment and the workspace .env).");
  const targetDatabaseName = envVar(dotenv, "TARGET_DATABASE_NAME") || "rhen";
  const testDatabaseName = envVar(dotenv, "TEST_DATABASE_NAME") || `${targetDatabaseName}_test`;
  if (!/^[A-Za-z][A-Za-z0-9_]*_test$/.test(testDatabaseName)) {
    fail(`Test database name "${testDatabaseName}" must be an identifier ending in _test.`);
  }
  return { adminUrl, testDatabaseUrl: databaseUrlFor(adminUrl, testDatabaseName), testDatabaseName };
}

/**
 * Runs a command to completion with its output on ours; rejects on a non-zero exit. With
 * `timeoutMs` the command is killed, whole process group included, when it runs past that; this
 * needs `detached: true` (POSIX), which also puts the command in the signal handlers' reach.
 */
export function run(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(" ")}`);
  const { timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", ...spawnOpts });
    foregroundChildren.add(child);
    if (spawnOpts.detached) detachedChildren.add(child);
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killProcessTreeSync(child);
        }, timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (timer) clearTimeout(timer);
      foregroundChildren.delete(child);
      detachedChildren.delete(child);
      if (timedOut) reject(new Error(`${cmd} ran past ${timeoutMs / 1000}s and was stopped`));
      else if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Synchronously kills a process tree, not just the immediate child's pid. On Windows pnpm launches
 * vinext through a .cmd shim, so a plain child.kill() leaves the actual `node` server running behind
 * it; on POSIX the server runs in its own process group (see `startDetached`), so this takes `pnpm`,
 * its shell and the `vinext` node process together. Killing only the pnpm pid orphans the server,
 * which then squats on the port and holds the step's stdout open, so a CI step would never end.
 * Safe to call twice and from the `exit` handler.
 */
export function killProcessTreeSync(child) {
  if (!child || !child.pid) return;
  if (IS_WIN) {
    if (child.exitCode !== null) return;
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  // Always tried, even when the pnpm wrapper has already exited or been signalled: the server can
  // outlive it, and the group id stays valid for as long as any member does. ESRCH means the group
  // is already gone.
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try {
        child.kill("SIGKILL");
      } catch {
        // Nothing left to kill.
      }
    }
  }
}

/**
 * Starts a long-running process in its own process group and remembers it, so a signal or an unplanned
 * exit of this script still kills the whole tree. Pair with `stopDetached`.
 */
export function startDetached(cmd, args, opts = {}) {
  log(`> ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, { stdio: "inherit", detached: !IS_WIN, ...opts });
  child.on("error", (error) => {
    child.startError = error;
  });
  detachedChildren.add(child);
  return child;
}

export function stopDetached(child) {
  killProcessTreeSync(child);
  detachedChildren.delete(child);
}

/** Polls `url` until it answers 200, failing early if `child` exits or never starts. */
export async function waitForReady(child, url, { label = "production server", timeoutMs = READY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  let exitInfo = "";
  child.once("exit", (code, signal) => {
    exited = true;
    exitInfo = `code ${code}, signal ${signal}`;
  });
  while (Date.now() < deadline) {
    if (child.startError) fail(`The ${label} could not be started (${child.startError.message}).`);
    if (exited) fail(`The ${label} process exited before it answered (${exitInfo}).`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) {
        log(`The ${label} answered 200 at ${url}`);
        return;
      }
    } catch {
      // Not up yet — keep polling.
    }
    await sleep(500);
  }
  fail(`The ${label} did not answer 200 at ${url} within ${timeoutMs / 1000}s.`);
}

/**
 * Starts the built portal (`vinext start`) against `databaseUrl` on `port`, loopback only, with `env`
 * (ours by default) as the rest of its environment.
 */
export function startPortal({ databaseUrl, port, env = process.env }) {
  return startDetached(PNPM, ["--filter", "@openrhen/portal", "start"], {
    ...PNPM_OPTS,
    env: { ...env, DATABASE_URL: databaseUrl, PORT: String(port), HOST: "127.0.0.1" }
  });
}

/** A TCP port nothing is listening on right now, taken from the OS. */
export function findFreePort() {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

/** `pnpm --filter @openrhen/database <script>` with `env` added to ours. */
function runDatabaseScript(script, env) {
  return run(PNPM, ["--filter", "@openrhen/database", script], { ...PNPM_OPTS, env: { ...process.env, ...env } });
}

export function createDatabase(databaseName) {
  return runDatabaseScript("db:create", { TARGET_DATABASE_NAME: databaseName });
}

export function migrateDatabase(databaseUrl) {
  return runDatabaseScript("db:migrate", { DATABASE_URL: databaseUrl });
}

/**
 * A database of the phase's own on the admin server, removed on every way out of this process. The
 * drop is registered here, before `prepare()` creates and migrates it, so a create or migrate that
 * fails half way still gets cleaned up (`db:drop` does nothing for a database that is not there).
 * Call `drop()` when done; it runs once however often it is called. `db:drop` refuses any name that
 * does not end in _test.
 */
export function scratchDatabase(adminUrl, databaseName) {
  const url = databaseUrlFor(adminUrl, databaseName);
  const drop = registerCleanup(() => {
    log(`Dropping database "${databaseName}"...`);
    const dropped = spawnSync(PNPM, ["--filter", "@openrhen/database", "db:drop"], {
      ...PNPM_OPTS,
      stdio: "inherit",
      env: { ...process.env, TARGET_DATABASE_NAME: databaseName, POSTGRES_ADMIN_URL: adminUrl }
    });
    if (dropped.status !== 0) console.error(`[smoke] WARNING: could not drop database "${databaseName}".`);
  });
  return {
    name: databaseName,
    url,
    drop,
    async prepare() {
      await createDatabase(databaseName);
      await migrateDatabase(url);
    }
  };
}

function runAllCleanups() {
  for (const child of detachedChildren) killProcessTreeSync(child);
  detachedChildren.clear();
  for (const child of foregroundChildren) child.kill("SIGTERM");
  // Last in, first out: a database goes only after the servers that were using it.
  for (const cleanup of [...exitCleanups].reverse()) cleanup();
}

/**
 * A CI cancel (or Ctrl+C) signals this script only, and a detached server would survive it. Kill the
 * servers' groups, close the browser, stop any build/migrate step in flight, drop the scratch
 * database, then exit with the conventional 128+signal status. Chrome is closed politely first and
 * killed if it does not go. The `exit` handler is the backstop for any other way out (an uncaught
 * throw, process.exit from another handler): `exit` handlers run synchronously, which is all a
 * SIGKILL of a group and a database drop need.
 */
export function installProcessHandlers() {
  const handleSignal = (signal, exitCode) => {
    log(`Received ${signal}; stopping the servers and the browser...`);
    for (const child of detachedChildren) killProcessTreeSync(child);
    detachedChildren.clear();
    for (const child of foregroundChildren) child.kill("SIGTERM");
    const browser = activeBrowser;
    activeBrowser = null;
    const closed = browser ? Promise.race([browser.close().catch(() => {}), sleep(3000)]) : Promise.resolve();
    void closed.then(() => {
      try {
        browser?.process()?.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      runAllCleanups();
      process.exit(exitCode);
    });
  };
  process.once("SIGINT", () => handleSignal("SIGINT", 130));
  process.once("SIGTERM", () => handleSignal("SIGTERM", 143));
  process.on("exit", runAllCleanups);
}
