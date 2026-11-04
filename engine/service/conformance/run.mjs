#!/usr/bin/env node
// Portable engine conformance runner. Dependency free: Node 22+ only (built-in fetch, fs, path).
// POSTs the `request` of each named wire fixture to an engine URL and checks the portable assertions.
// See README.md in this directory for what "portable" means and what a pass does not prove.
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the named fixtures live, relative to this file. */
export const DEFAULT_FIXTURE_DIR = resolve(here, "../../core/test/snapshot-replay");

/**
 * The corpus: a named list, never a directory scan, so a private capture can never be picked up.
 * Paths are relative to the fixture directory. Keep this list in step with the engine's
 * `snapshot-replay` suites; `conformance.test.ts` fails when a listed file is missing.
 */
export const FIXTURES = [
  "leave-by-allows-for-variability.json",
  "tracked-overtime-keeps-return-leg.json",
  "travel-leg-protects-the-journey.json",
  "synthetic/after-work-steps-follow-overtime-finish.json",
  "synthetic/arrived-pack-bag-no-longer-directed.json",
  "synthetic/bedtime-routine-survives-midnight-rollover.json",
  "synthetic/behind-prep-pace-for-a-commitment.json",
  "synthetic/cancelled-recurring-commitment-still-protects-sleep.json",
  "synthetic/completed-overridden-sleep-plan-stops-blocking-capacity.json",
  "synthetic/overdue-external-outranks-unknown-forecast.json",
  "synthetic/pending-ready-check-outranked-by-travel.json",
  "synthetic/replanned-sleep-stays-directable.json",
  "synthetic/routine-step-directive-honors-unmet-prerequisite.json",
  "synthetic/running-late-directs-pack-bag.json",
  "synthetic/sleep-walks-back-before-a-routine-chain.json",
  "synthetic/wake-early-prep-uniform-then-sleep.json",
  "synthetic/wake-only-completed-sleep-must-not-pin-bedtime.json"
];

const DIRECTIVE_KINDS = [
  "action",
  "sleep",
  "routine_step",
  "deliverable",
  "travel",
  "recovery",
  "answer",
  "boundary",
  "none"
];
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value) => typeof value === "string" && value.length > 0;
const isIso = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));

/**
 * Dependency-free shape check of a response body: only the top-level fields every consumer reads.
 * The committed JSON Schema in platform/contracts/engine-wire/ is the authority; a conforming engine
 * should also validate against it with any JSON Schema validator. Valid shape is necessary, not sufficient.
 */
export function checkShape(body) {
  const problems = [];
  if (!isObject(body)) return ["response is not a JSON object"];
  for (const key of ["contractVersion", "requestId", "inputVersion", "engineVersion"])
    if (!isString(body[key])) problems.push(`${key} must be a non-empty string`);
  for (const key of ["calculatedAt", "validUntil"])
    if (!isIso(body[key])) problems.push(`${key} must be an ISO date-time`);
  if (!isObject(body.derivedState)) problems.push("derivedState must be an object");
  else
    for (const key of ["sleepPlans", "occurrences", "routineSteps"])
      if (!Array.isArray(body.derivedState[key])) problems.push(`derivedState.${key} must be an array`);
  for (const key of ["schedule", "recommendation", "continuation"])
    if (!(key in body)) problems.push(`${key} is missing`);
  if (!isObject(body.currentDirective) || !isString(body.currentDirective.kind))
    problems.push("currentDirective must be an object with a kind");
  else if (!DIRECTIVE_KINDS.includes(body.currentDirective.kind))
    problems.push(`currentDirective.kind "${body.currentDirective.kind}" is not a known kind`);
  if (body.upcomingDirectives !== undefined && !Array.isArray(body.upcomingDirectives))
    problems.push("upcomingDirectives must be an array");
  if (body.dayPlan !== undefined && !(isObject(body.dayPlan) && Array.isArray(body.dayPlan.blocks)))
    problems.push("dayPlan must be an object with a blocks array");
  return problems;
}

/**
 * The portable subset of a fixture's `expect`. Anything not read here is reference-only:
 * `dayPlan` lines, directive titles and minutes, and numeric prepPace fields depend on the reference
 * engine's exact policy and are not required of another implementation.
 */
export function checkPortable(expected, body) {
  const failures = [];
  const expectEqual = (label, want, got) => {
    if (want !== got) failures.push(`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  };
  if (expected.primaryActionId !== undefined)
    expectEqual("primary action", expected.primaryActionId, body.recommendation?.primary?.action?.id ?? null);
  if (expected.currentDirective !== undefined) {
    const want = expected.currentDirective;
    expectEqual("directive kind", want === null ? null : want.kind, body.currentDirective?.kind ?? null);
    if (want?.targetId !== undefined) expectEqual("directive target", want.targetId, body.currentDirective?.targetId);
  }
  for (const [actionId, tier] of Object.entries(expected.candidateTiers ?? {})) {
    const candidates = Array.isArray(body.recommendation?.candidates) ? body.recommendation.candidates : [];
    expectEqual(`tier of ${actionId}`, tier, candidates.find((item) => item.action?.id === actionId)?.criticalTier);
  }
  for (const [projectId, health] of Object.entries(expected.health ?? {})) {
    const forecasts = Array.isArray(body.schedule?.forecasts) ? body.schedule.forecasts : [];
    expectEqual(`health of ${projectId}`, health, forecasts.find((item) => item.projectId === projectId)?.health);
  }
  if (expected.prepPace !== undefined)
    expectEqual(
      "prep pace status",
      expected.prepPace === null ? null : expected.prepPace.status,
      body.prepPace?.status ?? null
    );
  return failures;
}

/** Run one fixture against the engine. Never throws: every problem becomes a failure line. */
export async function runFixture(name, fixture, { url, token, fetchImpl = fetch }) {
  const failures = [];
  const request = fixture.request;
  let response;
  try {
    response = await fetchImpl(`${url}/v1/plan-and-forecast`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(request)
    });
  } catch (error) {
    return { name, failures: [`request failed: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
  if (response.status !== 200) {
    return { name, failures: [`HTTP ${response.status}, expected 200`] };
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return { name, failures: ["response body is not JSON"] };
  }
  failures.push(...checkShape(body));
  if (body?.requestId !== request.requestId)
    failures.push(`requestId not echoed: sent ${request.requestId}, got ${body?.requestId}`);
  if (body?.contractVersion !== request.contractVersion)
    failures.push(`contractVersion: expected ${request.contractVersion}, got ${body?.contractVersion}`);
  if (isObject(body)) failures.push(...checkPortable(fixture.expect ?? {}, body));
  return { name, failures };
}

export async function runAll({ url, token, fixtureDir = DEFAULT_FIXTURE_DIR, names = FIXTURES, fetchImpl }) {
  const results = [];
  for (const name of names) {
    let fixture;
    try {
      fixture = JSON.parse(await readFile(join(fixtureDir, name), "utf8"));
    } catch (error) {
      results.push({
        name,
        failures: [`fixture unreadable: ${error instanceof Error ? error.message : "unknown error"}`]
      });
      continue;
    }
    results.push(await runFixture(name, fixture, { url, token, fetchImpl }));
  }
  return results;
}

export function parseArgs(argv, env) {
  const options = { url: undefined, tokenEnv: "PLAN_FORECAST_SERVICE_TOKEN", fixtureDir: DEFAULT_FIXTURE_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    if (flag === "--url") options.url = value();
    else if (flag === "--token-env") options.tokenEnv = value();
    else if (flag === "--fixtures") options.fixtureDir = resolve(value());
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!options.url) throw new Error("--url is required, for example --url http://127.0.0.1:4000");
  options.url = options.url.replace(/\/+$/, "");
  options.token = env[options.tokenEnv] ?? "";
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env, out = (line) => console.log(line)) {
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (error) {
    out(`usage: node run.mjs --url <engine url> [--token-env NAME] [--fixtures DIR]\n${error.message}`);
    return 2;
  }
  if (!options.token) out(`note: no token in $${options.tokenEnv}; sending requests without authorisation`);
  const results = await runAll(options);
  for (const { name, failures } of results) {
    out(`${failures.length === 0 ? "PASS" : "FAIL"}  ${name}`);
    for (const failure of failures) out(`        ${failure}`);
  }
  const failed = results.filter((result) => result.failures.length > 0).length;
  out(`\n${results.length - failed}/${results.length} fixtures passed (portable assertions only)`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then((code) => process.exit(code));
}
