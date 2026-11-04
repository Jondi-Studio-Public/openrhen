import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { checkEnv } from "./check-env.mjs";
import { makeRoot } from "./fixture.mjs";
import { initEnv } from "./init-env.mjs";

const check = (root, env = {}) => {
  const out = makeRoot();
  const code = checkEnv({ cwd: root.cwd, env, stdout: out.stdout });
  return { code, output: out.output() };
};
const initialised = () => {
  const root = makeRoot();
  initEnv({ cwd: root.cwd, argv: [], env: {}, stdout: root.stdout });
  return root;
};

test("fails on a fresh copy of the example, naming variables only", () => {
  const root = makeRoot();
  writeFileSync(
    join(root.cwd, ".env"),
    "COMPOSE_PROFILES=app,bundled-db\nDATABASE_URL=postgresql://u:__POSTGRES_PASSWORD__@postgres/d\nOUTBOUND_PROXY_TOKEN=replace-before-lan-use\n"
  );
  const { code, output } = check(root);
  assert.equal(code, 1);
  assert.match(output, /OUTBOUND_PROXY_TOKEN/);
  assert.match(output, /POSTGRES_PASSWORD/);
  assert.match(output, /WEB_PUSH_VAPID_PRIVATE_KEY/);
});

test("passes after init-env", () => {
  const { code, output } = check(initialised());
  assert.equal(code, 0, output);
});

test("needs POSTGRES_PASSWORD only when COMPOSE_PROFILES includes bundled-db", () => {
  const root = initialised();
  assert.equal(check(root, { POSTGRES_PASSWORD: "", COMPOSE_PROFILES: "app,bundled-db" }).code, 1);
  assert.equal(check(root, { POSTGRES_PASSWORD: "", COMPOSE_PROFILES: "app" }).code, 0);
});

test("the shell wins over .env, and a shell DATABASE_URL gets a warning", () => {
  const root = initialised();
  const blanked = check(root, { OUTBOUND_PROXY_TOKEN: "" });
  assert.equal(blanked.code, 1);
  assert.match(blanked.output, /OUTBOUND_PROXY_TOKEN/);
  const warned = check(root, { DATABASE_URL: "postgresql://elsewhere/db" });
  assert.equal(warned.code, 0);
  assert.match(warned.output, /warning: DATABASE_URL/);
});

const MODEL = JSON.stringify({
  services: {
    portal: { profiles: ["planning", "app"], "x-openrhen": { secrets: ["NOTES_TOKEN"] } },
    notes: { profiles: ["planning", "app"], build: {}, "x-openrhen": { secrets: ["NOTES_DB_URL"] } },
    other: { profiles: ["planning"], image: "x", "x-openrhen": { secrets: ["OTHER_TOKEN"] } }
  }
});

test("add-on secrets from the merged compose model are checked when COMPOSE_FILE is set", () => {
  const root = initialised();
  const env = { COMPOSE_FILE: "compose.yaml:compose.addon.yaml", COMPOSE_PROFILES: "app" };
  const out = makeRoot();
  const code = checkEnv({ cwd: root.cwd, env, stdout: out.stdout, run: () => MODEL });
  assert.equal(code, 1);
  assert.match(out.output(), /NOTES_TOKEN/);
  assert.match(out.output(), /NOTES_DB_URL/);
  assert.doesNotMatch(out.output(), /OTHER_TOKEN/);
  const ok = makeRoot();
  const set = { ...env, NOTES_TOKEN: "a", NOTES_DB_URL: "b" };
  assert.equal(checkEnv({ cwd: root.cwd, env: set, stdout: ok.stdout, run: () => MODEL }), 0, ok.output());
});

test("a COMPOSE_FILE in .env counts, and without one compose is never run", () => {
  const root = initialised();
  writeFileSync(
    join(root.cwd, ".env"),
    `${readFileSync(join(root.cwd, ".env"), "utf8")}\nCOMPOSE_FILE=a.yaml:b.yaml\n`
  );
  const out = makeRoot();
  assert.equal(checkEnv({ cwd: root.cwd, env: {}, stdout: out.stdout, run: () => MODEL }), 1);
  assert.match(out.output(), /NOTES_TOKEN/);
  const plain = initialised();
  const quiet = makeRoot();
  const run = () => {
    throw new Error("must not run");
  };
  assert.equal(checkEnv({ cwd: plain.cwd, env: {}, stdout: quiet.stdout, run }), 0);
});
