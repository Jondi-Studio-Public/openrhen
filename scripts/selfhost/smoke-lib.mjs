// The pure parts of the self-host smoke test (scripts/selfhost/smoke.mjs), kept apart so unit tests
// can cover them without Docker. `node:` built-ins only, nothing runs at import.
//
// Exports:
//   ENV_ALLOWLIST, scrubEnv(env, platform)       the only variables a docker call may inherit
//   REFUSED_CONTEXT_PATTERN, assertSafeContext(name, env)   refuse a context that looks like a live or remote server
//   parseArgs(argv)                               --keep, --skip-build, --timeout-minutes
//   projectName(random)                           selfhost-smoke-<hex>
//   parsePsJson(text)                             `docker compose ps --format json` -> rows
//   exposedPorts(rows)                            published ports bound beyond loopback
//   isLoopbackAddress(addr)
//   SERVICE_SPEC, serviceProblems(rows, spec)     what is not yet healthy / exited 0
//   LOG_ALLOWLIST, findUnexpectedErrors(...)      "level":"error" lines not on the allowlist
//   STEPS, newResults(), formatTable(results)     the nine steps and the pass/fail table
//   smokeEnvValues(opts)                          the keys the temp .env is given

import { randomBytes, randomUUID } from "node:crypto";

/** Names a docker (or CLI) child may inherit. A live DATABASE_URL in the caller's shell never gets in. */
export const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "TEMP",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "ALLUSERSPROFILE",
  "APPDATA",
  "LOCALAPPDATA"
];

/** Keeps only `ENV_ALLOWLIST`. Windows env names are case-insensitive (`Path`), so match loosely there. */
export function scrubEnv(env, platform = process.platform) {
  const windows = platform === "win32";
  const allowed = new Set(ENV_ALLOWLIST.map((name) => (windows ? name.toLowerCase() : name)));
  const clean = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (allowed.has(windows ? name.toLowerCase() : name)) clean[name] = value;
  }
  return clean;
}

/**
 * Docker contexts the smoke will not run against: any name with a `remote`, `live`, `prod` or `production` word in it
 * (split on `-`, `_` or `.`), plus any names listed in `SMOKE_REFUSED_CONTEXTS` (comma-separated). The endpoint check in
 * `assertLocalDocker` is the stronger guard; this catches a server reached through a local socket or tunnel.
 */
export const REFUSED_CONTEXT_PATTERN = /(?:^|[-_.])(?:remote|live|prod|production)(?:$|[-_.])/i;

export function assertSafeContext(contextName, env = process.env) {
  const name = String(contextName ?? "").trim();
  if (name === "") throw new Error("Could not tell which Docker context is active; refusing to run.");
  const extra = String(env?.SMOKE_REFUSED_CONTEXTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (REFUSED_CONTEXT_PATTERN.test(name) || extra.includes(name))
    throw new Error(
      `Docker context "${name}" looks like a live server; the smoke test builds and deletes things. Refusing to run.`
    );
  return name;
}

/**
 * The full decision on where docker will talk to: the context name must not look like a live server, and the
 * effective endpoint must be local. `DOCKER_HOST`, when set, overrides the context (and `context show`
 * still prints `default`), so it is checked first; otherwise the context's own endpoint is. Only
 * `unix://` and `npipe://` count as local: ssh://, tcp:// and anything unreadable are refused.
 */
export function assertLocalDocker({ contextName, contextHost, dockerHost, env }) {
  const name = assertSafeContext(contextName, env);
  const override = String(dockerHost ?? "").trim();
  const endpoint = override !== "" ? override : String(contextHost ?? "").trim();
  if (endpoint === "") throw new Error(`Could not read the Docker endpoint for context "${name}"; refusing to run.`);
  if (!/^(unix|npipe):\/\//.test(endpoint))
    throw new Error(
      `Docker endpoint ${override !== "" ? "DOCKER_HOST" : `of context "${name}"`} is not local (${endpoint.split("@").pop()}); ` +
        "the smoke test builds and deletes things. Refusing to run."
    );
  return { name, endpoint };
}

export function parseArgs(argv) {
  const options = { keep: false, skipBuild: false, timeoutMinutes: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--timeout-minutes" || arg.startsWith("--timeout-minutes=")) {
      const raw = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      const minutes = Number(raw);
      if (!Number.isFinite(minutes) || minutes <= 0)
        throw new Error(`--timeout-minutes needs a positive number, got ${raw}.`);
      options.timeoutMinutes = minutes;
    } else throw new Error(`Unknown option ${arg}. Options: --keep, --skip-build, --timeout-minutes <n>.`);
  }
  return options;
}

export function projectName(random = () => randomBytes(4).toString("hex")) {
  return `selfhost-smoke-${random()}`;
}

/** Compose v2 prints either one JSON array or one object per line, depending on the version. */
export function parsePsJson(text) {
  const trimmed = String(text ?? "").trim();
  if (trimmed === "") return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed);
  return trimmed
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

export function isLoopbackAddress(address) {
  const value = String(address ?? "")
    .trim()
    .replace(/^\[|\]$/g, "");
  return value.startsWith("127.") || value === "::1" || value.toLowerCase() === "localhost";
}

/**
 * Published ports (PublishedPort > 0) whose bind address is not loopback. A blank address counts as
 * exposed: Docker reports `0.0.0.0` or `::` for "every interface", and a blank is not proof of loopback.
 */
export function exposedPorts(rows) {
  const exposed = [];
  for (const row of rows) {
    for (const publisher of row.Publishers ?? []) {
      if (!publisher.PublishedPort || publisher.PublishedPort <= 0) continue;
      if (isLoopbackAddress(publisher.URL)) continue;
      exposed.push({
        service: row.Service ?? row.Name,
        address: publisher.URL || "(blank)",
        published: publisher.PublishedPort,
        target: publisher.TargetPort
      });
    }
  }
  return exposed;
}

/** Services that must be healthy and one-shots that must have exited 0. */
export const SERVICE_SPEC = {
  healthy: ["postgres", "engine-service", "outbound-proxy", "portal"],
  exitedZero: ["migrate"]
};

/** Human-readable reasons the stack is not ready yet; empty when it is. */
export function serviceProblems(rows, spec = SERVICE_SPEC) {
  const byService = new Map(rows.map((row) => [row.Service ?? row.Name, row]));
  const problems = [];
  for (const name of spec.healthy) {
    const row = byService.get(name);
    if (!row) problems.push(`${name}: not created`);
    else if (row.State !== "running" || row.Health !== "healthy")
      problems.push(`${name}: ${row.State}/${row.Health || "no health"}`);
  }
  for (const name of spec.exitedZero) {
    const row = byService.get(name);
    if (!row) problems.push(`${name}: not created`);
    else if (row.State !== "exited" || row.ExitCode !== 0)
      problems.push(`${name}: ${row.State} (exit ${row.ExitCode})`);
  }
  return problems;
}

/**
 * Error log lines the smoke tolerates, one reason each. Empty until a real run shows a line that is
 * expected on a stack with no the roster provider or calendar set up; a line that is a bug gets a fix PR instead.
 * Shape: { service: "portal" | "*", pattern: RegExp, reason: string }.
 */
export const LOG_ALLOWLIST = [];

export const LOG_SERVICES = [
  "postgres",
  "engine-service",
  "outbound-proxy",
  "migrate",
  "backup",
  "engine-worker",
  "portal"
];

const ERROR_LINE = /"level"\s*:\s*"error"/;

/** Lines in one service's log that carry `"level":"error"` and match no allowlist entry for that service. */
export function findUnexpectedErrors(service, logText, allowlist = LOG_ALLOWLIST) {
  for (const entry of allowlist) {
    if (!entry.reason || !entry.reason.trim()) throw new Error("Every log allowlist entry needs a reason.");
  }
  const entries = allowlist.filter((entry) => entry.service === "*" || entry.service === service);
  return String(logText ?? "")
    .split(/\r?\n/)
    .filter((line) => ERROR_LINE.test(line))
    .filter((line) => !entries.some((entry) => entry.pattern.test(line)))
    .map((line) => ({ service, line: line.length > 300 ? `${line.slice(0, 300)}...` : line }));
}

export const STEPS = [
  { id: "isolate", name: "Isolate (tree copy, project, scrubbed env, context)" },
  { id: "setup", name: "Setup (.env and ports)" },
  { id: "start", name: "Start (healthy, migrated, health routes)" },
  { id: "use", name: "Use (capture, recalculate, plan run, photo)" },
  { id: "persist", name: "Persist (restart, down/up)" },
  { id: "backup", name: "Backup (db:backup, db:restore:verify)" },
  { id: "exposure", name: "Exposure (loopback-only ports)" },
  { id: "logs", name: "Logs (no unexpected error lines)" },
  { id: "teardown", name: "Tear down" }
];

export function newResults() {
  return STEPS.map((step) => ({ ...step, status: "skipped", detail: "" }));
}

export function formatTable(results) {
  const width = Math.max(...results.map((result) => result.name.length));
  return results
    .map((result, index) => {
      const label = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP";
      return `${index + 1}. ${result.name.padEnd(width)}  ${label}${result.detail ? `  ${result.detail}` : ""}`;
    })
    .join("\n");
}

/** What the temp .env is given on top of init-env's output. */
export function smokeEnvValues({ portalPort, postgresPort, imagePrefix, imageTag, backup = true }) {
  const values = { PORTAL_PORT: String(portalPort), POSTGRES_HOST_PORT: String(postgresPort) };
  if (imagePrefix) values.IMAGE_PREFIX = imagePrefix;
  if (imageTag) values.IMAGE_TAG = imageTag;
  if (backup) {
    values.BACKUP_COPY = "off";
    values.BACKUP_PING_URL = "off";
  }
  return values;
}

/**
 * An id the portal keeps as sent: its rule (tools/cli/src/commands/save.ts PORTAL_UUID) is a UUID of
 * version 1 to 5; any other id is hashed to a different UUID, so a plan result would never name it.
 */
export function newCommitmentId() {
  return randomUUID();
}

/** `repository:tag` lines from `docker images` that belong to this project's builds (`<project>-<service>:<tag>`). */
export function ownImageRefs(listing, project) {
  const refs = String(listing ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${project}-`) && !line.includes("<none>"));
  return [...new Set(refs)];
}

/**
 * The fields `rhen save commitment --create --id <id> --fields <json>` needs: title, startsAt and
 * endsAt (the duration is their difference; the contract requires a UTC-offset date-time). Starts two
 * hours out so it falls inside the planning horizon, lasts `minutes`.
 */
export function commitmentFields({ id, title, now = new Date(), minutes = 45 }) {
  const startsAt = new Date(now.getTime() + 2 * 60 * 60_000);
  const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
  return {
    id,
    title,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: "confirmed",
    setupBeforeMinutes: 0,
    transitionAfterMinutes: 0
  };
}

/**
 * Whether a `state --key planning` document is a finished plan run that names the commitment: status
 * `current`, and the id appears as a value anywhere in `result` (`commitmentTimelines`, a day plan
 * block's target, a protected list). Matching the unique id as a whole value keeps this independent of
 * which part of the result carries it.
 */
export function planIncludesCommitment(planning, id) {
  if (!planning || planning.status !== "current" || !planning.result) return false;
  const seen = (value) => {
    if (value === id) return true;
    if (Array.isArray(value)) return value.some(seen);
    if (value && typeof value === "object") return Object.values(value).some(seen);
    return false;
  };
  return seen(planning.result);
}
