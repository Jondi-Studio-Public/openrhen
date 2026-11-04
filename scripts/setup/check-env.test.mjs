import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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
