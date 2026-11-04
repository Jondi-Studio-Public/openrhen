import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  changedPaths,
  conformance,
  composeViolations,
  envViolations,
  isAddonOwned,
  ownershipViolations,
  registrationViolations,
  routeViolations,
  SINGLE_SLOT_STUBS
} from "./conformance.mjs";

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "conformance-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("add-on owned paths are the compose file, its own addons folder and the route group", () => {
  assert.equal(isAddonOwned("compose.addon.yaml", "example"), true);
  assert.equal(isAddonOwned("addons/example/env.example", "example"), true);
  assert.equal(isAddonOwned("addons/other/env.example", "example"), false);
  assert.equal(isAddonOwned("portal/app/(addon)/hello/page.tsx", "example"), true);
  assert.equal(isAddonOwned("portal/app/today/page.tsx", "example"), false);
  assert.equal(isAddonOwned("compose.yaml", "example"), false);
  assert.equal(isAddonOwned("portal/app/(addon)/../today/page.tsx", "example"), false);
});

test("changedPaths lists added and modified files, and ignores identical ones", () => {
  const core = tree({ "a.txt": "1", "b.txt": "2", "sub/c.txt": "3" });
  const merged = tree({ "a.txt": "1", "b.txt": "changed", "sub/c.txt": "3", "new/d.txt": "4" });
  try {
    assert.deepEqual(changedPaths(core, merged), [
      { path: "b.txt", kind: "modified" },
      { path: "new/d.txt", kind: "added" }
    ]);
  } finally {
    rmSync(core, { recursive: true });
    rmSync(merged, { recursive: true });
  }
});

test("only add-on owned paths and the documented stubs may differ from core", () => {
  const changes = [
    { path: "compose.addon.yaml", kind: "added" },
    { path: "portal/app/(addon)/hello/page.tsx", kind: "added" },
    { path: SINGLE_SLOT_STUBS[0], kind: "modified" }
  ];
  assert.deepEqual(ownershipViolations(changes, "example"), []);
});

test("a core file edit, a deleted stub slot or a stray new file is a violation with the path named", () => {
  const errors = ownershipViolations(
    [
      { path: "compose.yaml", kind: "modified" },
      { path: "portal/server/new-file.ts", kind: "added" },
      { path: "platform/contracts/src/private/other.ts", kind: "added" },
      { path: "portal/app/today/page.tsx", kind: "modified" }
    ],
    "example"
  );
  assert.equal(errors.length, 4);
  assert.match(errors[0], /compose\.yaml/);
  assert.match(errors[0], /core file/);
});

test("a stub the overlay creates where core has none is also a violation", () => {
  const errors = ownershipViolations([{ path: SINGLE_SLOT_STUBS[0], kind: "added" }], "example");
  assert.equal(errors.length, 1);
});

const MODEL = {
  services: {
    portal: { profiles: ["app"], "x-openrhen": { secrets: ["EXAMPLE_TOKEN"] } },
    "engine-service": { profiles: ["app"] },
    notes: {
      profiles: ["app"],
      build: { dockerfile: "addons/example/Dockerfile" },
      depends_on: { "engine-service": { condition: "service_healthy" } },
      "x-openrhen": { secrets: ["EXAMPLE_TOKEN"] }
    }
  }
};

test("a merged model with an add-on service that depends on core passes", () => {
  assert.deepEqual(composeViolations(MODEL, { secretKeys: ["EXAMPLE_TOKEN"] }), []);
});

test("composeViolations names a missing add-on service, a missing profile and an unknown dependency", () => {
  assert.match(composeViolations({ services: { portal: {} } }, { secretKeys: [] })[0], /no add-on service/);
  const noProfile = structuredClone(MODEL);
  delete noProfile.services.notes.profiles;
  assert.match(composeViolations(noProfile, { secretKeys: [] })[0], /profiles/);
  const badDep = structuredClone(MODEL);
  badDep.services.notes.depends_on = { ghost: {} };
  assert.match(composeViolations(badDep, { secretKeys: ["EXAMPLE_TOKEN"] })[0], /ghost/);
});

test("a secret the compose file names but no env fragment declares is a violation", () => {
  const errors = composeViolations(MODEL, { secretKeys: [] });
  assert.equal(errors.length > 0, true);
  assert.match(errors[0], /EXAMPLE_TOKEN/);
});

const FRAGMENT = "# @secret\nEXAMPLE_TOKEN=\n\nEXAMPLE_INTERVAL=60\n";

test("an env fragment generates its secret once and is stable on a second run", () => {
  const cwd = tree({ "addons/example/env.example": FRAGMENT });
  try {
    const result = envViolations({ cwd, coreEnvExample: "PORT=1\n" });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.secretKeys, ["EXAMPLE_TOKEN"]);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("a fragment key that core's .env.example also sets is a violation", () => {
  const cwd = tree({ "addons/example/env.example": FRAGMENT });
  try {
    const { errors } = envViolations({ cwd, coreEnvExample: "EXAMPLE_INTERVAL=5\n" });
    assert.match(errors[0], /EXAMPLE_INTERVAL/);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("a repo with no env fragment reports it", () => {
  const cwd = tree({ "x.txt": "" });
  try {
    assert.match(envViolations({ cwd, coreEnvExample: "" }).errors[0], /no addons/);
  } finally {
    rmSync(cwd, { recursive: true });
  }
});

test("routeViolations reports a collision with a core URL and requires at least one add-on route", () => {
  const ok = tree({
    "portal/app/today/page.tsx": "",
    "portal/app/(addon)/hello/page.tsx": ""
  });
  const clash = tree({
    "portal/app/today/page.tsx": "",
    "portal/app/(addon)/today/page.tsx": ""
  });
  const none = tree({ "portal/app/today/page.tsx": "" });
  try {
    assert.deepEqual(routeViolations(ok), []);
    assert.match(routeViolations(clash)[0], /\/today/);
    assert.match(routeViolations(none)[0], /no add-on route/);
  } finally {
    for (const dir of [ok, clash, none]) rmSync(dir, { recursive: true });
  }
});

test("the example add-on's own files exist where the guide says", () => {
  const read = (path) =>
    readFileSync(new URL(`../../integrations/addon-example/overlay/${path}`, import.meta.url), "utf8");
  assert.match(read("compose.addon.yaml"), /x-openrhen/);
  assert.match(read("addons/example/env.example"), /@secret/);
  assert.match(read("portal/app/(addon)/hello/page.tsx"), /Hello/);
});

// The whole run against a copy of this repository, with compose's output injected so no Docker daemon is needed.
function repoCopyWithAddon(overlay) {
  const copy = mkdtempSync(join(tmpdir(), "conformance-repo-"));
  const here = join(dirname(new URL(import.meta.url).pathname), "../..");
  cpSync(here, copy, {
    recursive: true,
    filter: (source) => !/(^|\/)(\.git|node_modules|\.env)$/.test(source)
  });
  rmSync(join(copy, "integrations/addon-example"), { recursive: true });
  for (const [path, text] of Object.entries(overlay)) {
    mkdirSync(dirname(join(copy, "bad/overlay", path)), { recursive: true });
    writeFileSync(join(copy, "bad/overlay", path), text);
  }
  return copy;
}

const sink = {
  chunks: [],
  write(text) {
    this.chunks.push(text);
  }
};

test("a run fails and names the file when an overlay replaces compose.yaml", () => {
  const copy = repoCopyWithAddon({
    "compose.yaml": "services: {}\n",
    "compose.addon.yaml": "services: {}\n",
    "addons/bad/env.example": "# @secret\nBAD_TOKEN=\n"
  });
  sink.chunks = [];
  try {
    const failures = conformance({ repoRoot: copy, addonDir: "bad", run: () => JSON.stringify(MODEL), stdout: sink });
    assert.equal(
      failures.some((line) => line.startsWith("compose.yaml was modified")),
      true
    );
    assert.match(sink.chunks.join(""), /FAIL only add-on owned paths/);
  } finally {
    rmSync(copy, { recursive: true });
  }
});

test("registrationViolations passes when registerComposeAddons registers the add-on service and its secrets", () => {
  assert.deepEqual(registrationViolations(MODEL), []);
});

test("registrationViolations fails when the model adds no service the deploy scripts would learn of", () => {
  assert.match(registrationViolations({ services: { portal: {} } })[0], /registerComposeAddons/);
});
