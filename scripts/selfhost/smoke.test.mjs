import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { parseEnvText } from "../setup/env-file.mjs";
import { makeRoot } from "../setup/fixture.mjs";
import {
  assertSafeContext,
  assertLocalDocker,
  commitmentFields,
  newCommitmentId,
  ownImageRefs,
  planIncludesCommitment,
  ENV_ALLOWLIST,
  exposedPorts,
  findUnexpectedErrors,
  formatTable,
  newResults,
  parseArgs,
  parsePsJson,
  projectName,
  scrubEnv,
  serviceProblems,
  smokeEnvValues,
  STEPS
} from "./smoke-lib.mjs";

test("scrubEnv keeps only the allowed names", () => {
  const clean = scrubEnv(
    {
      PATH: "/bin",
      HOME: "/home/a",
      USERPROFILE: "C:\\Users\\a",
      SystemRoot: "C:\\Windows",
      DOCKER_HOST: "unix:///x.sock",
      DOCKER_CONTEXT: "default",
      TEMP: "/tmp",
      DOCKER_CONFIG: "/home/a/.docker",
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      ProgramData: "C:\\ProgramData",
      ALLUSERSPROFILE: "C:\\ProgramData",
      APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
      DATABASE_URL: "postgres://live",
      POSTGRES_ADMIN_URL: "postgres://admin",
      COMPOSE_PROFILES: "planning",
      EXAMPLE_API_KEY: "sk-x",
      UNSET: undefined
    },
    "linux"
  );
  assert.deepEqual(Object.keys(clean).sort(), [...ENV_ALLOWLIST].sort());
  assert.equal(clean.DATABASE_URL, undefined);
});

test("scrubEnv matches names case-insensitively on Windows only", () => {
  assert.deepEqual(scrubEnv({ Path: "C:\\bin", DATABASE_URL: "x" }, "win32"), { Path: "C:\\bin" });
  assert.deepEqual(scrubEnv({ Path: "/bin" }, "linux"), {});
});

test("assertSafeContext refuses a context that looks like a live server", () => {
  assert.throws(() => assertSafeContext("my-remote\n"), /live server/);
  assert.throws(() => assertSafeContext("prod"), /live server/);
  assert.throws(() => assertSafeContext("staging", { SMOKE_REFUSED_CONTEXTS: "other, staging" }), /live server/);
  assert.equal(assertSafeContext("staging", {}), "staging");
  assert.throws(() => assertSafeContext(""), /Could not tell/);
  assert.equal(assertSafeContext("desktop-linux\n"), "desktop-linux");
  assert.equal(assertSafeContext("default"), "default");
});

test("parseArgs reads the three flags and refuses anything else", () => {
  assert.deepEqual(parseArgs([]), { keep: false, skipBuild: false, timeoutMinutes: 10 });
  assert.deepEqual(parseArgs(["--keep", "--skip-build", "--timeout-minutes", "25"]), {
    keep: true,
    skipBuild: true,
    timeoutMinutes: 25
  });
  assert.equal(parseArgs(["--timeout-minutes=3"]).timeoutMinutes, 3);
  assert.throws(() => parseArgs(["--timeout-minutes", "0"]), /positive/);
  assert.throws(() => parseArgs(["--volumes"]), /Unknown option/);
});

test("projectName is never the live project", () => {
  assert.match(projectName(), /^selfhost-smoke-[0-9a-f]{8}$/);
  assert.notEqual(projectName(), "rhen");
  assert.equal(
    projectName(() => "abc"),
    "selfhost-smoke-abc"
  );
});

const row = (service, publishers, extra = {}) => ({ Service: service, Publishers: publishers, ...extra });

test("parsePsJson reads both an array and one object per line", () => {
  const one = { Service: "a" };
  const two = { Service: "b" };
  assert.deepEqual(parsePsJson(JSON.stringify([one, two])), [one, two]);
  assert.deepEqual(parsePsJson(`${JSON.stringify(one)}\n${JSON.stringify(two)}\n`), [one, two]);
  assert.deepEqual(parsePsJson(""), []);
});

test("exposedPorts passes loopback and unpublished ports", () => {
  const rows = [
    row("portal", [{ URL: "127.0.0.1", TargetPort: 8787, PublishedPort: 8787, Protocol: "tcp" }]),
    row("postgres", [{ URL: "::1", TargetPort: 5432, PublishedPort: 55432, Protocol: "tcp" }]),
    row("outbound-proxy", [{ URL: "", TargetPort: 4200, PublishedPort: 0, Protocol: "tcp" }]),
    row("migrate", [])
  ];
  assert.deepEqual(exposedPorts(rows), []);
});

test("exposedPorts flags every non-loopback bind, including a blank one", () => {
  const rows = [
    row("portal", [
      { URL: "0.0.0.0", TargetPort: 8787, PublishedPort: 8787 },
      { URL: "::", TargetPort: 8787, PublishedPort: 8787 }
    ]),
    row("engine-service", [{ URL: "192.0.2.14", TargetPort: 4100, PublishedPort: 4100 }]),
    row("postgres", [{ TargetPort: 5432, PublishedPort: 5432 }]),
    row("backup", undefined)
  ];
  const exposed = exposedPorts(rows);
  assert.deepEqual(
    exposed.map((p) => `${p.service}@${p.address}`),
    ["portal@0.0.0.0", "portal@::", "engine-service@192.0.2.14", "postgres@(blank)"]
  );
});

test("serviceProblems wants four healthy services and migrate exited 0", () => {
  const healthy = (Service) => ({ Service, State: "running", Health: "healthy" });
  const ready = [
    healthy("postgres"),
    healthy("engine-service"),
    healthy("outbound-proxy"),
    healthy("portal"),
    { Service: "migrate", State: "exited", ExitCode: 0 }
  ];
  assert.deepEqual(serviceProblems(ready), []);
  const bad = [
    healthy("postgres"),
    { Service: "engine-service", State: "running", Health: "starting" },
    { Service: "migrate", State: "exited", ExitCode: 1 }
  ];
  assert.deepEqual(serviceProblems(bad), [
    "engine-service: running/starting",
    "outbound-proxy: not created",
    "portal: not created",
    "migrate: exited (exit 1)"
  ]);
});

test("findUnexpectedErrors reports error lines and honours a service-scoped allowlist", () => {
  const logs = [
    '{"level":"info","message":"started"}',
    '{"level":"error","message":"example_daily sync failed: not configured"}',
    '{ "level": "error", "message":"boom" }',
    "plain text mentioning error"
  ].join("\n");
  assert.equal(findUnexpectedErrors("portal", logs, []).length, 2);
  const allow = [
    {
      service: "portal",
      pattern: /example_daily sync failed/,
      reason: "Example Daily is not set up in the stranger stack"
    }
  ];
  assert.deepEqual(
    findUnexpectedErrors("portal", logs, allow).map((e) => e.line),
    ['{ "level": "error", "message":"boom" }']
  );
  // An entry for another service does not cover this one.
  assert.equal(findUnexpectedErrors("engine-worker", logs, allow).length, 2);
  assert.equal(findUnexpectedErrors("engine-worker", logs, [{ ...allow[0], service: "*" }]).length, 1);
});

test("findUnexpectedErrors refuses an allowlist entry with no reason and truncates long lines", () => {
  assert.throws(() => findUnexpectedErrors("portal", "", [{ service: "*", pattern: /x/, reason: " " }]), /reason/);
  const long = `{"level":"error","message":"${"x".repeat(1000)}"}`;
  assert.ok(findUnexpectedErrors("portal", long, [])[0].line.length < 310);
});

test("the step table has the nine plan steps in order, all skipped until they run", () => {
  assert.deepEqual(
    STEPS.map((s) => s.id),
    ["isolate", "setup", "start", "use", "persist", "backup", "exposure", "logs", "teardown"]
  );
  const results = newResults();
  results[0].status = "pass";
  results[1].status = "fail";
  results[1].detail = "setup did not write .env";
  const lines = formatTable(results).split("\n");
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^1\. .*PASS$/);
  assert.match(lines[1], /FAIL {2}setup did not write \.env$/);
  assert.match(lines[2], /SKIP$/);
});

test("smokeEnvValues sets ports, the backup opt-outs and, for a pulled image run, the image", () => {
  const built = smokeEnvValues({ portalPort: 18787, postgresPort: 15432, imagePrefix: "selfhost-smoke-ab" });
  assert.deepEqual(built, {
    PORTAL_PORT: "18787",
    POSTGRES_HOST_PORT: "15432",
    IMAGE_PREFIX: "selfhost-smoke-ab",
    BACKUP_COPY: "off",
    BACKUP_PING_URL: "off"
  });
  const pulled = smokeEnvValues({ portalPort: 1, postgresPort: 2, imagePrefix: "ghcr.io/x/y", imageTag: "abc" });
  assert.equal(pulled.IMAGE_TAG, "abc");
});

test("the keys the smoke writes exist in .env.example's vocabulary and round-trip through the env reader", () => {
  const { cwd } = makeRoot();
  const example = readFileSync(`${cwd}/.env.example`, "utf8");
  assert.match(example, /PORTAL_HOST_IP=127\.0\.0\.1/);
  const values = smokeEnvValues({ portalPort: 1, postgresPort: 2, imagePrefix: "p" });
  assert.deepEqual(
    Object.keys(
      parseEnvText(
        Object.entries(values)
          .map(([k, v]) => `${k}=${v}`)
          .join("\n")
      )
    ),
    Object.keys(values)
  );
});

test("assertLocalDocker accepts only a local endpoint, and DOCKER_HOST overrides the context", () => {
  const local = { contextName: "default\n", contextHost: "unix:///var/run/docker.sock\n" };
  assert.deepEqual(assertLocalDocker(local), { name: "default", endpoint: "unix:///var/run/docker.sock" });
  assert.equal(assertLocalDocker({ ...local, contextHost: "npipe:////./pipe/docker_engine" }).name, "default");
  assert.equal(assertLocalDocker({ ...local, dockerHost: "unix:///run/user/1000/docker.sock" }).name, "default");
  // The bypass: context show says "default" but DOCKER_HOST points at the server.
  assert.throws(() => assertLocalDocker({ ...local, dockerHost: "ssh://192.0.2.41" }), /not local.*192\.0\.2\.41/);
  assert.throws(() => assertLocalDocker({ ...local, dockerHost: "tcp://192.0.2.41:2375" }), /not local/);
  // A renamed context that points at the server.
  assert.throws(() => assertLocalDocker({ contextName: "home", contextHost: "ssh://192.0.2.41" }), /not local/);
  // The name check still applies, and an unreadable endpoint is refused.
  assert.throws(() => assertLocalDocker({ contextName: "my-remote", contextHost: "unix:///x" }), /live server/);
  assert.throws(() => assertLocalDocker({ contextName: "default", contextHost: "" }), /Could not read/);
});

test("ownImageRefs picks this project's name:tag refs only", () => {
  const listing = [
    "selfhost-smoke-ab-portal:dev",
    "selfhost-smoke-ab-backup:dev",
    "selfhost-smoke-ab-portal:dev",
    "selfhost-smoke-abc-portal:dev",
    "openrhen-portal:dev",
    "<none>:<none>",
    ""
  ].join("\n");
  assert.deepEqual(ownImageRefs(listing, "selfhost-smoke-ab"), [
    "selfhost-smoke-ab-portal:dev",
    "selfhost-smoke-ab-backup:dev"
  ]);
});

test("newCommitmentId is a UUID the portal keeps as sent, and unique", () => {
  const portalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const a = newCommitmentId();
  assert.match(a, portalUuid);
  assert.notEqual(a, newCommitmentId());
  assert.equal(commitmentFields({ id: a, title: "T" }).id, a);
});

test("commitmentFields gives a title, a UTC-offset start and end, and the requested duration", () => {
  const now = new Date("2026-10-30T10:00:00Z");
  const fields = commitmentFields({ id: "commitment-x", title: "T", now, minutes: 30 });
  assert.equal(fields.id, "commitment-x");
  assert.equal(fields.startsAt, "2026-10-30T12:00:00.000Z");
  assert.equal(fields.endsAt, "2026-10-30T12:30:00.000Z");
  assert.equal(fields.status, "confirmed");
});

test("planIncludesCommitment needs a current run that names the id", () => {
  const result = { dayPlan: { blocks: [{ kind: "commitment", targetId: "commitment-x" }] }, commitmentTimelines: [] };
  assert.equal(planIncludesCommitment({ status: "current", result }, "commitment-x"), true);
  const timelines = { commitmentTimelines: [{ id: "commitment-x" }] };
  assert.equal(planIncludesCommitment({ status: "current", result: timelines }, "commitment-x"), true);
  assert.equal(planIncludesCommitment({ status: "pending", result }, "commitment-x"), false);
  assert.equal(planIncludesCommitment({ status: "current", result }, "commitment-y"), false);
  assert.equal(planIncludesCommitment({ status: "current" }, "commitment-x"), false);
  assert.equal(planIncludesCommitment(null, "commitment-x"), false);
  assert.equal(planIncludesCommitment({ status: "current", result: { t: "see commitment-x" } }, "commitment-x"), false);
});
