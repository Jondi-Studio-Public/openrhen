import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  DEPENDS_ON,
  MIGRATE_DEPENDENTS,
  dependencyClosure,
  deployServicesFor,
  upArgsFor
} from "./service-selection.mjs";
import { deployServiceExtensions } from "./service-extensions.mjs";

// The services a registered extension adds (private/index.mjs; none in the OpenRhen export), and the ones among them
// that write to the database through migrate.
const EXTENSIONS = deployServiceExtensions().map((entry) => entry.service);
const EXTENSION_WRITERS = deployServiceExtensions()
  .filter((entry) => entry.dependsOn.includes("migrate"))
  .map((entry) => entry.service);
const WRITERS = ["portal", "engine-worker", ...EXTENSION_WRITERS];
const ALL_WIDE = [...WRITERS, "migrate"];

/** `depends_on` per service, read from compose.yaml (list or map form). */
function composeDependsOn() {
  const found = {};
  let service = null;
  let inDepends = false;
  for (const line of readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8").split("\n")) {
    const top = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (top) {
      service = top[1];
      inDepends = false;
      continue;
    }
    if (!service) continue;
    if (/^ {4}depends_on:/.test(line)) {
      inDepends = true;
      found[service] = [];
    } else if (/^ {4}\S/.test(line)) inDepends = false;
    else if (inDepends) {
      const entry = /^ {6}(?:- )?([a-z][a-z0-9-]*)(?::\s*)?$/.exec(line.replace(/#.*$/, "").trimEnd());
      if (entry) found[service].push(entry[1]);
    }
  }
  return found;
}

test("the dependency map matches compose.yaml", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(DEPENDS_ON).map(([name, deps]) => [name, [...deps].sort()])),
    Object.fromEntries(Object.entries(composeDependsOn()).map(([name, deps]) => [name, [...deps].sort()]))
  );
});

test("the migrate dependents are the writers", () => {
  assert.deepEqual([...MIGRATE_DEPENDENTS].sort(), [...WRITERS].sort());
});

test("each migrate dependent widens to all the writers plus migrate", () => {
  for (const service of MIGRATE_DEPENDENTS) {
    assert.deepEqual(deployServicesFor([service]).sort(), [...ALL_WIDE].sort(), service);
  }
});

test("--service migrate no longer runs alone: the writers are recreated first", () => {
  assert.deepEqual(deployServicesFor(["migrate"]).sort(), [...ALL_WIDE].sort());
});

test("services that do not reach migrate are left alone", () => {
  assert.deepEqual(deployServicesFor(["engine-service"]), ["engine-service"]);
  assert.deepEqual(deployServicesFor(["outbound-proxy"]), ["outbound-proxy"]);
});

test("a full deploy has no duplicates", () => {
  const all = ["portal", "engine-service", "engine-worker", "outbound-proxy", "migrate", ...EXTENSIONS];
  assert.deepEqual(deployServicesFor(all).sort(), [...all].sort());
});

test("a run that includes migrate force-recreates, so cached images cannot leave writers running", () => {
  for (const service of ["portal", "engine-worker", "migrate", ...EXTENSIONS]) {
    const up = upArgsFor(deployServicesFor([service]));
    assert.deepEqual(up.slice(0, 3), ["-d", "--no-build", "--force-recreate"], service);
    for (const writer of ["migrate", ...WRITERS]) assert.ok(up.includes(writer), `${service} up includes ${writer}`);
  }
});

test("a run that never reaches migrate is not force-recreated", () => {
  assert.deepEqual(upArgsFor(deployServicesFor(["engine-service"])), ["-d", "--no-build", "engine-service"]);
  assert.deepEqual(upArgsFor(deployServicesFor(["outbound-proxy"])), ["-d", "--no-build", "outbound-proxy"]);
});

test("the dependency closure adds what compose up starts, such as portal's outbound-proxy", () => {
  assert.deepEqual(dependencyClosure(["engine-worker"]).sort(), ["engine-service", "engine-worker", "migrate"]);
  assert.deepEqual(
    dependencyClosure(deployServicesFor(["migrate"])).sort(),
    [...ALL_WIDE, "engine-service", "outbound-proxy"].sort()
  );
});
