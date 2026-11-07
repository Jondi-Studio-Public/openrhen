// The production smoke's second phase: the demo seed (`pnpm seed:demo`) against a portal, engine and
// worker of its own.
//
// The click phase proves the built bundle renders. This one proves the whole write path still works
// end to end: it makes a database of its own, starts the engine service, the engine worker and the
// built portal against it, runs the demo seed (which writes only through the portal's routes, through
// the CLI, plus the records it has no route for), and passes only when the seed exits 0 and the
// plan it asked for was then really calculated and the Now answer has a directive. So a route, a
// command schema or an engine contract that drifts from what the seed (and an agent) sends fails the
// PR that did it.
//
// Nothing here touches any database but the one this phase creates:
//   - the name is minted per run (`<base>_seedsmoke<pid>x<time>_test`), so it cannot be the click
//     phase's database, an integration run's, or the live one;
//   - every child gets that URL explicitly, and the environment is stripped of the settings that point
//     a portal or CLI somewhere else;
//   - the portal and engine listen on ports taken from the OS, never on a fixed one another server
//     might hold, so the seed cannot reach a portal that is not this phase's;
//   - the seed has guards of its own: it refuses a non-local URL and a portal whose first setup is done.
// Everything started here, and the database, is removed on every way out (see boot.mjs).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  IS_WIN,
  PNPM,
  PNPM_OPTS,
  ROOT,
  fail,
  findFreePort,
  log,
  resolveTestDatabaseUrl,
  run,
  scratchDatabase,
  sleep,
  startDetached,
  startPortal,
  stopDetached,
  waitForReady
} from "./boot.mjs";

const SEED_TIMEOUT_MS = 10 * 60_000;
const PLAN_TIMEOUT_MS = 90_000;

/**
 * Settings from the developer's shell or CI that would aim a portal, the CLI or the seed at someone
 * else's instance, or switch the seed into a mode this phase does not want. All dropped from every
 * child of this phase.
 */
const FOREIGN_SETTINGS = [
  "OPENRHEN_URL",
  "OPENRHEN_TOKEN",
  "OPENRHEN_OWNER_TOKEN",
  "OPENRHEN_MCP_TOKEN",
  "OPENRHEN_AGENT",
  "OPENRHEN_OWNER_AUTH",
  "OPENRHEN_AGENT_AUTH",
  "OPENRHEN_AGENT_TOKENS",
  "OPENRHEN_ACTIVITY_CONTENT_DEFAULT",
  "PORTAL_INTERNAL_URL",
  "PLAN_FORECAST_SERVICE_URL",
  "PLAN_FORECAST_SERVICE_TOKEN",
  "PLAN_FORECAST_HOST",
  "PLAN_FORECAST_PORT"
];
/** Blank, not absent: the seed loads the workspace .env and would fill an absent one from it. */
const SEED_MODES = ["DEMO_SEED_NOW", "DEMO_SEED_FORCE", "DEMO_SEED_MARKER"];
/** The built CLI the seed and the final read run: tsx would add about half a second to each of their couple of hundred calls. */
const CLI_BUNDLE = resolve(ROOT, "tools/cli/dist/rhen.mjs");

/** The name of this run's database: a `_test` name no other run, suite or phase can share. */
export function seedDatabaseName(testDatabaseName, pid = process.pid, nowMs = Date.now()) {
  // Postgres identifiers stop at 63 characters; the base is the only part that is not bounded.
  const base = testDatabaseName.replace(/_test$/, "").slice(0, 24);
  return `${base}_seedsmoke${pid}x${nowMs.toString(36)}_test`;
}

/**
 * The seed's own environment. The seed loads the workspace .env, which fills any setting that is absent,
 * so the ones `phaseEnv` dropped are blanked here instead (a blank token or agent name reads as none).
 */
export function seedEnv(env, settings) {
  const blanked = Object.fromEntries(FOREIGN_SETTINGS.filter((key) => !(key in env)).map((key) => [key, ""]));
  return { ...env, ...blanked, ...settings };
}

/** `baseEnv` without the settings that point elsewhere, then with this phase's own `settings`. */
export function phaseEnv(baseEnv, settings) {
  const env = { ...baseEnv };
  for (const key of FOREIGN_SETTINGS) delete env[key];
  for (const key of SEED_MODES) env[key] = "";
  return { ...env, ...settings };
}

/** IPv4 literals on a private network (RFC 1918): the documented gate setup keeps Postgres on the LAN. */
const PRIVATE_IPV4 = /^(10\.\d+|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d+\.\d+$/;

/** Throws unless `databaseUrl` is the scratch database this phase made, on this machine or the LAN Postgres. */
export function assertSeedTarget(databaseUrl, databaseName) {
  const url = new URL(databaseUrl);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && !PRIVATE_IPV4.test(url.hostname))
    fail(`refusing to seed ${url.hostname}: the seed phase writes only to a database on this machine or the LAN`);
  if (decodeURIComponent(url.pathname) !== `/${databaseName}`)
    fail(`refusing to seed ${url.pathname.slice(1)}: the seed phase writes only to ${databaseName}`);
}

/** Runs one named step; a failure comes out saying which step it was. */
async function step(name, work) {
  log(`Seed phase: ${name}...`);
  try {
    return await work();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`Seed phase failed at step "${name}": ${reason}`);
  }
}

function assertRunning(processes, when) {
  for (const [name, child] of processes) {
    if (child.startError) fail(`The ${name} could not be started (${child.startError.message}) ${when}.`);
    if (child.exitCode !== null || child.signalCode !== null)
      fail(`The ${name} exited (code ${child.exitCode}, signal ${child.signalCode}) ${when}.`);
  }
}

/**
 * Polls the portal's state until the engine has calculated the plan and has no newer work waiting: a
 * run the worker finished while the seed was still writing does not count, since the seed's later
 * writes queue a recalculation that is "awaiting" until it lands.
 */
async function waitForPlan(baseUrl, processes) {
  const deadline = Date.now() + PLAN_TIMEOUT_MS;
  let seen = "the portal gave no answer";
  while (Date.now() < deadline) {
    assertRunning(processes, "before the plan was calculated");
    try {
      const response = await fetch(`${baseUrl}/api/state`, { signal: AbortSignal.timeout(5000) });
      const planning = (await response.json())?.state?.planning;
      if (planning?.status === "current" && planning.lastSuccessfulAt && !planning.awaitingRecalculation) {
        log(
          `The plan was calculated at ${planning.lastSuccessfulAt} (status ${planning.status}, nothing newer waiting).`
        );
        return;
      }
      seen =
        `planning status ${planning?.status ?? "missing"}` +
        `${planning?.awaitingRecalculation ? ", a recalculation still waiting" : ""}` +
        `${planning?.message ? `, "${planning.message}"` : ""}`;
    } catch (error) {
      seen = `the state read failed (${error instanceof Error ? error.message : String(error)})`;
    }
    await sleep(1000);
  }
  fail(`No up-to-date plan within ${PLAN_TIMEOUT_MS / 1000}s of the seed finishing (last seen: ${seen}).`);
}

/** `rhen status --json`, the read an agent makes: the plan's age and the Now answer's directive. */
function readNowAnswer(baseUrl, env) {
  const result = spawnSync(process.execPath, [CLI_BUNDLE, "status", "--json"], {
    env: { ...env, OPENRHEN_URL: baseUrl, OPENRHEN_TIMEOUT_MS: "60000" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status !== 0)
    fail(`rhen status exited ${result.status}: ${(result.stderr || result.stdout || "").trim().slice(0, 500)}`);
  let status;
  try {
    status = JSON.parse(result.stdout);
  } catch {
    return fail(`rhen status --json did not print JSON: ${result.stdout.slice(0, 300)}`);
  }
  if (!status.plan?.calculatedAt) fail("rhen status reports no calculated plan.");
  if (!status.directive) fail("rhen status reports no Now directive.");
  return status;
}

export async function runSeedPhase() {
  const startedAt = Date.now();
  log("Phase 2 of 2: the demo seed against its own database, engine and portal");

  const { adminUrl, testDatabaseName } = resolveTestDatabaseUrl();
  const database = scratchDatabase(adminUrl, seedDatabaseName(testDatabaseName));
  log(`Using database "${database.name}" (created for this run and dropped after it).`);
  const started = [];
  try {
    await step("create and migrate the seed database", () => database.prepare());

    const token = randomBytes(24).toString("hex");
    const enginePort = await findFreePort();
    const portalPort = await findFreePort();
    const baseUrl = `http://127.0.0.1:${portalPort}`;
    const engineUrl = `http://127.0.0.1:${enginePort}`;
    const env = phaseEnv(process.env, {
      DATABASE_URL: database.url,
      PLAN_FORECAST_SERVICE_URL: engineUrl,
      PLAN_FORECAST_SERVICE_TOKEN: token
    });
    // The engine and worker run as their Docker images do, from the esbuild bundle (`dist/main.js`), but
    // without `pnpm start`'s `--env-file-if-exists=../../.env`: nothing in the workspace .env, such as
    // PORTAL_INTERNAL_URL or the live token, may reach them.
    const startEngineProcess = (workspace, extraEnv) =>
      startDetached(process.execPath, ["dist/main.js"], {
        cwd: resolve(ROOT, "engine", workspace),
        env: { ...env, ...extraEnv }
      });

    await step("build the engine service, engine worker and CLI", () =>
      run(
        PNPM,
        [
          "--filter",
          "@openrhen/engine-service",
          "--filter",
          "@openrhen/engine-worker",
          "--filter",
          "@openrhen/cli",
          "build"
        ],
        { ...PNPM_OPTS, cwd: ROOT, env }
      )
    );

    const service = await step("start the engine service", async () => {
      const child = startEngineProcess("service", {
        PLAN_FORECAST_HOST: "127.0.0.1",
        PLAN_FORECAST_PORT: String(enginePort)
      });
      started.push(child);
      await waitForReady(child, `${engineUrl}/health`, { label: "engine service" });
      return child;
    });

    const worker = await step("start the engine worker", async () => {
      const child = startEngineProcess("worker", {});
      started.push(child);
      return child;
    });

    const portal = await step("start the portal", async () => {
      log(`Starting the production server on ${baseUrl}...`);
      const child = startPortal({ databaseUrl: database.url, port: portalPort, env });
      started.push(child);
      await waitForReady(child, `${baseUrl}/`);
      return child;
    });

    const processes = [
      ["engine service", service],
      ["engine worker", worker],
      ["portal", portal]
    ];

    await step("run seed:demo", async () => {
      assertSeedTarget(env.DATABASE_URL, database.name);
      assertRunning(processes, "before the seed started");
      try {
        await run(PNPM, ["seed:demo"], {
          ...PNPM_OPTS,
          cwd: ROOT,
          detached: !IS_WIN,
          timeoutMs: SEED_TIMEOUT_MS,
          env: seedEnv(env, { OPENRHEN_URL: baseUrl, DEMO_SEED_CLI: CLI_BUNDLE })
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        fail(`${reason} (the seed's own report of what failed is in the output above)`);
      }
    });

    await step("wait for the plan to be calculated", () => waitForPlan(baseUrl, processes));

    const status = await step("read the Now answer", async () => readNowAnswer(baseUrl, env));
    const directive = status.directive;
    log(`Now answer: ${directive.kind}${directive.title ? ` - ${directive.title}` : ""}`);
  } finally {
    log("Stopping the seed phase's engine, worker and portal...");
    for (const child of started) stopDetached(child);
    database.drop();
  }
  log(`Seed phase passed in ${Math.round((Date.now() - startedAt) / 1000)}s.`);
}
