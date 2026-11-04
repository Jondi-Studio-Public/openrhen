import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { addonEntries, loadComposeModel, registerComposeAddons, usesAddons } from "./compose-addons.mjs";
import { deployServiceExtensions } from "./service-extensions.mjs";

// What `docker compose config --format json --profile "*"` prints for core plus one add-on file.
const core = (extra = {}) => ({
  name: "openrhen",
  services: {
    portal: { profiles: ["planning", "app"], build: { dockerfile: "a" }, depends_on: { migrate: {} } },
    migrate: { profiles: ["planning", "app"], build: {} },
    postgres: { profiles: ["bundled-db"] },
    setup: { profiles: ["setup"] },
    ...extra
  }
});
const MODEL = core({
  notes: {
    profiles: ["planning", "app"],
    build: { dockerfile: "addon/Dockerfile" },
    depends_on: { migrate: { condition: "service_completed_successfully" }, portal: {} },
    "x-openrhen": { secrets: ["NOTES_TOKEN"] }
  },
  sidecar: { profiles: ["planning", "app"], image: "example/sidecar:1" }
});
MODEL.services.portal["x-openrhen"] = { secrets: ["NOTES_TOKEN"] };

test("only services the core compose file does not own become entries", () => {
  const entries = addonEntries(MODEL);
  assert.deepEqual(entries.map((entry) => entry.service).sort(), ["notes", "portal", "sidecar"]);
  const notes = entries.find((entry) => entry.service === "notes");
  assert.deepEqual(notes, {
    service: "notes",
    dependsOn: ["migrate", "portal"],
    secrets: ["NOTES_TOKEN"],
    builds: true
  });
  const sidecar = entries.find((entry) => entry.service === "sidecar");
  assert.deepEqual(sidecar, { service: "sidecar", dependsOn: [], secrets: [], builds: false });
});

test("a core service appears only for the secrets an add-on appends to it", () => {
  const portal = addonEntries(MODEL).find((entry) => entry.service === "portal");
  assert.deepEqual(portal.secrets, ["NOTES_TOKEN"]);
  assert.deepEqual(addonEntries(core()), []);
});

test("an add-on service without profiles is refused, since compose would start it in every stack", () => {
  assert.throws(() => addonEntries(core({ loose: { image: "x" } })), /loose.*profiles/);
});

test("list-form depends_on is read too", () => {
  const entries = addonEntries(core({ a: { profiles: ["app"], image: "x", depends_on: ["portal"] } }));
  assert.deepEqual(entries[0].dependsOn, ["portal"]);
});

test("the loader runs compose config with every profile, the merged files and the caller's environment", () => {
  const calls = [];
  const run = (args, options) => {
    calls.push({ args, options });
    return JSON.stringify(MODEL);
  };
  const env = { COMPOSE_FILE: "compose.yaml:compose.addon.yaml" };
  const model = loadComposeModel({ cwd: "/repo", env, run });
  assert.deepEqual(model, MODEL);
  assert.deepEqual(calls[0].args.slice(0, 4), ["compose", "--profile", "*", "config"]);
  assert.ok(calls[0].args.includes("json") && calls[0].args.includes("--profile") && calls[0].args.includes("*"));
  assert.ok(calls[0].args.includes("--no-interpolate"));
  assert.equal(calls[0].options.cwd, "/repo");
  assert.equal(calls[0].options.env.COMPOSE_FILE, env.COMPOSE_FILE);
});

test("a compose failure or unreadable output is reported, not swallowed", () => {
  assert.throws(
    () =>
      loadComposeModel({
        run: () => {
          throw new Error("no such file");
        }
      }),
    /no such file/
  );
  assert.throws(() => loadComposeModel({ run: () => "not json" }), /compose config/);
});

test("add-ons are in play only when COMPOSE_FILE is set", () => {
  assert.equal(usesAddons({}), false);
  assert.equal(usesAddons({ COMPOSE_FILE: "" }), false);
  assert.equal(usesAddons({ COMPOSE_FILE: "compose.yaml:compose.addon.yaml" }), true);
});

test("registering merges add-on services and secrets into the deploy maps without losing the core ones", async () => {
  const { DEPENDS_ON, MIGRATE_DEPENDENTS, deployServicesFor } = await import("./service-selection.mjs");
  const { SERVICE_SECRETS, findUnusableSecrets } = await import("./required-secrets.mjs");
  registerComposeAddons({ env: { COMPOSE_FILE: "x" }, run: () => JSON.stringify(MODEL) });
  assert.deepEqual(
    deployServiceExtensions()
      .map((entry) => entry.service)
      .sort(),
    ["notes", "portal", "sidecar"]
  );
  assert.deepEqual(DEPENDS_ON.notes, ["migrate", "portal"]);
  assert.ok(DEPENDS_ON.portal.includes("engine-service") && DEPENDS_ON.portal.includes("migrate"));
  assert.ok(MIGRATE_DEPENDENTS.includes("notes"));
  assert.deepEqual(deployServicesFor(["notes"]).sort(), ["engine-worker", "migrate", "notes", "portal"]);
  assert.ok(SERVICE_SECRETS.portal.includes("DATABASE_URL") && SERVICE_SECRETS.portal.includes("NOTES_TOKEN"));
  assert.deepEqual(SERVICE_SECRETS.notes, ["NOTES_TOKEN"]);
  assert.deepEqual(findUnusableSecrets(["notes"], {}), ["NOTES_TOKEN"]);
  assert.deepEqual(findUnusableSecrets(["notes"], { NOTES_TOKEN: "real" }), []);
});

test("registering without COMPOSE_FILE never calls compose", () => {
  const entries = registerComposeAddons({
    env: {},
    run: () => {
      throw new Error("must not run");
    }
  });
  assert.deepEqual(entries, []);
});

const hasDocker = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/compose.addon.yaml", import.meta.url));

test(
  "real docker compose merges compose.yaml with an add-on file, with either path separator",
  { skip: !hasDocker },
  () => {
    for (const separator of [":", ";"]) {
      const env = {
        ...process.env,
        COMPOSE_PATH_SEPARATOR: separator,
        COMPOSE_FILE: ["compose.yaml", fixture].join(separator)
      };
      const model = loadComposeModel({ cwd: root, env });
      const entries = addonEntries(model);
      assert.deepEqual(entries.map((entry) => entry.service).sort(), ["notes", "portal"], separator);
      assert.deepEqual(entries.find((entry) => entry.service === "notes").dependsOn, ["migrate"]);
      assert.deepEqual(entries.find((entry) => entry.service === "portal").secrets, ["NOTES_TOKEN"]);
      assert.match(model.services.portal.build.dockerfile, /addon\/Dockerfile\.portal$/);
      const portalEnv = model.services.portal.environment;
      assert.ok(portalEnv.includes("NOTES_TOKEN=${NOTES_TOKEN:-}"), "add-on env is appended");
      assert.ok(portalEnv.includes("DATABASE_URL=${DATABASE_URL}"), "core portal env is kept");
    }
  }
);
