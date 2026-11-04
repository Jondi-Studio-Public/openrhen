import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PLACEHOLDER, SERVICE_SECRETS, findUnusableSecrets, readDotenv } from "./required-secrets.mjs";
import { deployServiceExtensions } from "./service-extensions.mjs";

const ALL = Object.keys(SERVICE_SECRETS);
const complete = {
  DATABASE_URL: "postgresql://u:p@host:5432/db",
  PLAN_FORECAST_SERVICE_TOKEN: "a",
  OUTBOUND_PROXY_TOKEN: "b",
  // Whatever a registered extension service needs (none in the OpenRhen export).
  ...Object.fromEntries(
    deployServiceExtensions().flatMap((entry) => entry.secrets.map((name) => [name, "postgresql://c:p@host:5432/db"]))
  ),
  WEB_PUSH_VAPID_PUBLIC_KEY: "c",
  WEB_PUSH_VAPID_PRIVATE_KEY: "d",
  WEB_PUSH_SUBJECT: "mailto:someone@example.com"
};

test("passes when every secret the services need is present", () => {
  assert.deepEqual(findUnusableSecrets(ALL, complete), []);
});

test("reports unset secrets by name, once each", () => {
  assert.deepEqual(findUnusableSecrets(["portal", "engine-worker"], {}), [
    "DATABASE_URL",
    "PLAN_FORECAST_SERVICE_TOKEN",
    "OUTBOUND_PROXY_TOKEN"
  ]);
});

test("treats blank, whitespace and the compose placeholder as unusable", () => {
  const env = { ...complete, DATABASE_URL: "", PLAN_FORECAST_SERVICE_TOKEN: "  ", OUTBOUND_PROXY_TOKEN: PLACEHOLDER };
  assert.deepEqual(findUnusableSecrets(["portal"], env), [
    "DATABASE_URL",
    "PLAN_FORECAST_SERVICE_TOKEN",
    "OUTBOUND_PROXY_TOKEN"
  ]);
});

test("only demands what the deployed services use", () => {
  assert.deepEqual(findUnusableSecrets(["engine-service"], { PLAN_FORECAST_SERVICE_TOKEN: "x" }), []);
  assert.deepEqual(findUnusableSecrets(["outbound-proxy"], { PLAN_FORECAST_SERVICE_TOKEN: "x" }), [
    "OUTBOUND_PROXY_TOKEN",
    "WEB_PUSH_VAPID_PUBLIC_KEY",
    "WEB_PUSH_VAPID_PRIVATE_KEY",
    "WEB_PUSH_SUBJECT"
  ]);
});

test("does not demand the optional pulse publish pair", () => {
  assert.deepEqual(findUnusableSecrets(["outbound-proxy"], complete), []);
});

test("ignores services it does not know rather than crashing", () => {
  assert.deepEqual(findUnusableSecrets(["not-a-service"], {}), []);
});

test("reads a dotenv file: quotes, export, inline comments, missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "required-secrets-"));
  try {
    const file = join(dir, "sample.env");
    writeFileSync(file, ["A=plain # note", 'export B="quoted value"', "C='single'", "# D=commented", "E="].join("\n"));
    assert.deepEqual(readDotenv(file), { A: "plain", B: "quoted value", C: "single", E: "" });
    assert.deepEqual(readDotenv(join(dir, "missing.env")), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the migrate service needs the database URL and nothing else", () => {
  assert.deepEqual(findUnusableSecrets(["migrate"], {}), ["DATABASE_URL"]);
  assert.deepEqual(findUnusableSecrets(["migrate"], complete), []);
});
