import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import "./private/index.mjs";
import { deployServiceExtensions } from "./service-extensions.mjs";

// compose.yaml runs two stacks. The full deployment activates `planning` (the ci deploy workflow sets
// COMPOSE_PROFILES=planning on the server); a self-hosted stack uses `app` + `bundled-db`.
// these invariants keep the first unchanged while the second exists.

const SOURCE = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");

// The services a registered extension adds (private/index.mjs; none in the OpenRhen export).
const EXTENSION_SERVICES = deployServiceExtensions().map((entry) => entry.service);
const PLANNING = [
  "backup",
  "engine-service",
  "engine-worker",
  "migrate",
  "outbound-proxy",
  "portal",
  ...EXTENSION_SERVICES
].sort();
const APP = ["backup", "engine-service", "engine-worker", "migrate", "outbound-proxy", "portal"];

/** Per service: its `profiles`, `image`, whether it has `build:` and its `depends_on` names. */
function parseServices() {
  const services = {};
  let inServices = false;
  let service = null;
  let inDepends = false;
  for (const raw of SOURCE.split("\n")) {
    if (/^services:\s*$/.test(raw)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(raw) && !raw.startsWith("#")) inServices = false;
    if (!inServices) continue;
    const top = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(raw);
    if (top) {
      service = top[1];
      services[service] = { profiles: null, image: null, build: false, dependsOn: [] };
      inDepends = false;
      continue;
    }
    if (!service) continue;
    const line = raw.replace(/\s+#.*$/, "").trimEnd();
    const profiles = /^ {4}profiles:\s*\[(.*)\]\s*$/.exec(line);
    if (profiles) services[service].profiles = profiles[1].split(",").map((p) => p.trim().replace(/"/g, ""));
    const image = /^ {4}image:\s*(\S.*)$/.exec(line);
    if (image) services[service].image = image[1].trim();
    if (/^ {4}build:/.test(line)) services[service].build = true;
    if (/^ {4}depends_on:/.test(line)) {
      inDepends = true;
    } else if (/^ {4}\S/.test(line)) {
      inDepends = false;
    } else if (inDepends) {
      const entry = /^ {6}(?:- )?([a-z][a-z0-9-]*)(?::\s*)?$/.exec(line);
      if (entry) services[service].dependsOn.push(entry[1]);
    }
  }
  return services;
}

const services = parseServices();
const inProfile = (profile) =>
  Object.keys(services)
    .filter((name) => services[name].profiles?.includes(profile))
    .sort();

test("I1: the planning profile starts exactly the core services plus the registered extensions", () => {
  assert.deepEqual(inProfile("planning"), PLANNING);
});

test("I2: every service has a profiles key, so none runs without one", () => {
  for (const [name, spec] of Object.entries(services)) {
    assert.ok(spec.profiles && spec.profiles.length > 0, `${name} has no profiles`);
  }
});

test("I3: nothing uses a required-variable ${VAR:?message}", () => {
  assert.doesNotMatch(SOURCE.replace(/^\s*#.*$/gm, ""), /\$\{[^}]*:\?/);
});

test("I4: each built service is named <prefix>-<name>:<tag> with the project's prefix as the default", () => {
  const built = Object.entries(services).filter(([, spec]) => spec.build);
  assert.equal(built.length, 6 + deployServiceExtensions().filter((entry) => entry.builds).length);
  for (const [name, spec] of built) {
    const expected =
      name === "migrate"
        ? "${IMAGE_PREFIX:-ghcr.io/jondi-studio-public/openrhen}-migrate:${MIGRATE_IMAGE_TAG:-${IMAGE_TAG:-latest}}"
        : `\${IMAGE_PREFIX:-ghcr.io/jondi-studio-public/openrhen}-${name}:\${IMAGE_TAG:-latest}`;
    assert.equal(spec.image, expected, name);
  }
});

test("the app profile is exactly the six core services", () => {
  assert.deepEqual(inProfile("app"), APP);
});

test("the registered extension services are in planning only", () => {
  for (const name of EXTENSION_SERVICES) {
    assert.deepEqual(services[name].profiles, ["planning"], name);
  }
});

test("postgres and setup are in no profile that planning or app switches on", () => {
  assert.deepEqual(services.postgres.profiles, ["bundled-db"]);
  assert.deepEqual(services.setup.profiles, ["setup"]);
  for (const [name, spec] of Object.entries(services)) {
    if (name === "postgres" || name === "setup") continue;
    assert.ok(!spec.profiles.includes("bundled-db") && !spec.profiles.includes("setup"), name);
  }
});

test("no service depends_on postgres or setup, so an external DATABASE_URL still works", () => {
  for (const [name, spec] of Object.entries(services)) {
    assert.ok(!spec.dependsOn.includes("postgres"), `${name} depends on postgres`);
    assert.ok(!spec.dependsOn.includes("setup"), `${name} depends on setup`);
  }
});

test("the backup service gains exactly one empty-by-default key, BACKUP_COPY, beside BACKUP_COPY_DIR", () => {
  assert.match(SOURCE, /^ {6}BACKUP_COPY: \$\{BACKUP_COPY:-\}$/m);
  assert.match(SOURCE, /^ {6}BACKUP_COPY_DIR: \$\{BACKUP_COPY_DIR:\+\/backup-copy\}$/m);
  assert.match(SOURCE, /^ {6}- \$\{BACKUP_COPY_DIR:-\.\/var\/backup-copy\}:\/backup-copy$/m);
});

test("the portal port binds loopback unless PORTAL_HOST_IP says otherwise and the bundled database binds loopback only", () => {
  assert.match(SOURCE, /"\$\{PORTAL_HOST_IP:-127\.0\.0\.1\}:\$\{PORTAL_PORT:-8787\}:8787"/);
  assert.match(SOURCE, /"127\.0\.0\.1:\$\{POSTGRES_HOST_PORT:-55432\}:5432"/);
});
