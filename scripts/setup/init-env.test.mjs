import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { readDotenv } from "../deploy/required-secrets.mjs";
import { makeRoot } from "./fixture.mjs";
import { GENERATED, generateVapidKeys, initEnv, padVapidPrivateKey, parseArgs, sha256Hex } from "./init-env.mjs";

const run = (root, argv = [], stdout = root.stdout) => initEnv({ cwd: root.cwd, argv, env: {}, stdout });
const envOf = (root) => readDotenv(join(root.cwd, ".env"));

test("creates .env, generates every secret, fills the URL passwords and the folders", () => {
  const root = makeRoot();
  assert.equal(run(root), 0);
  const env = envOf(root);
  for (const key of GENERATED) assert.match(env[key], /^[0-9a-f]{64}$/);
  assert.equal(
    env.DATABASE_URL,
    `postgresql://openrhen:${env.POSTGRES_PASSWORD}@postgres:5432/openrhen?sslmode=disable`
  );
  assert.equal(
    env.POSTGRES_ADMIN_URL,
    `postgresql://openrhen:${env.POSTGRES_PASSWORD}@postgres:5432/postgres?sslmode=disable`
  );
  assert.equal(env.WEB_PUSH_SUBJECT, "mailto:admin@localhost");
  for (const dir of ["var/photos", "var/backups", "var/backups/pre-migrate"])
    assert.ok(existsSync(join(root.cwd, dir)));
  if (process.platform !== "win32") assert.equal(statSync(join(root.cwd, ".env")).mode & 0o777, 0o600);
});

test("the VAPID pair decodes to a 65-byte public key and a 32-byte private key", () => {
  const root = makeRoot();
  run(root);
  const env = envOf(root);
  assert.equal(Buffer.from(env.WEB_PUSH_VAPID_PUBLIC_KEY, "base64url").length, 65);
  assert.equal(Buffer.from(env.WEB_PUSH_VAPID_PRIVATE_KEY, "base64url").length, 32);
  assert.equal(Buffer.from(generateVapidKeys().publicKey, "base64url").length, 65);
});

test("output names keys and never contains a generated value", () => {
  const root = makeRoot();
  run(root);
  const env = envOf(root);
  const output = root.output();
  assert.match(output, /generated: .*POSTGRES_PASSWORD/);
  for (const key of [...GENERATED, "WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY"]) {
    assert.ok(!output.includes(env[key]), `${key} value leaked`);
  }
});

test("is idempotent: the second run changes nothing and generates nothing", () => {
  const root = makeRoot();
  run(root);
  const first = readFileSync(join(root.cwd, ".env"), "utf8");
  const second = makeRoot();
  assert.equal(run(root, [], second.stdout), 0);
  assert.equal(readFileSync(join(root.cwd, ".env"), "utf8"), first);
  assert.match(second.output(), /generated: nothing/);
});

test("never overwrites a real value, keeps comments, and fills the password into URLs", () => {
  const root = makeRoot();
  writeFileSync(
    join(root.cwd, ".env"),
    "# my notes\nPOSTGRES_PASSWORD=mine\nOUTBOUND_PROXY_TOKEN=keepme\nDATABASE_URL=postgresql://u:__POSTGRES_PASSWORD__@postgres:5432/d\nCUSTOM_THING=1\n"
  );
  run(root);
  const text = readFileSync(join(root.cwd, ".env"), "utf8");
  assert.ok(text.startsWith("# my notes\nPOSTGRES_PASSWORD=mine\nOUTBOUND_PROXY_TOKEN=keepme\n"));
  assert.ok(text.includes("DATABASE_URL=postgresql://u:mine@postgres:5432/d\n"));
  assert.ok(text.includes("CUSTOM_THING=1"));
  assert.ok(!root.output().includes("keepme"));
});

test("--mode source points the URLs at 127.0.0.1 and the published port", () => {
  const root = makeRoot();
  writeFileSync(
    join(root.cwd, ".env"),
    "POSTGRES_HOST_PORT=5544\nDATABASE_URL=postgresql://openrhen:__POSTGRES_PASSWORD__@postgres:5432/openrhen\nPOSTGRES_ADMIN_URL=postgresql://openrhen:__POSTGRES_PASSWORD__@postgres:5432/postgres\n"
  );
  run(root, ["--mode", "source"]);
  const env = envOf(root);
  assert.match(env.DATABASE_URL, /@127\.0\.0\.1:5544\/openrhen$/);
  assert.match(env.POSTGRES_ADMIN_URL, /@127\.0\.0\.1:5544\/postgres$/);
});

test("--mode source on a fresh example uses the default published port 55432", () => {
  const root = makeRoot();
  run(root, ["--mode", "source"]);
  const env = envOf(root);
  assert.equal(env.POSTGRES_HOST_PORT, "55432");
  assert.match(env.DATABASE_URL, /@127\.0\.0\.1:55432\/openrhen\?/);
});

test("--docker keeps UTC and hints; a fresh host run takes the host time zone", () => {
  const docker = makeRoot();
  run(docker, ["--docker"]);
  assert.equal(envOf(docker).APP_TIMEZONE, "UTC");
  assert.match(docker.output(), /hint: APP_TIMEZONE/);
  assert.match(docker.output(), /Next: run "docker compose up -d", then open http:\/\/localhost:8787/);
  const host = makeRoot();
  run(host);
  assert.equal(envOf(host).APP_TIMEZONE, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("the Next line names the LAN address when the portal is published beyond loopback", () => {
  const root = makeRoot();
  writeFileSync(join(root.cwd, ".env"), "PORTAL_HOST_IP=192.168.0.92\nPORTAL_PORT=9000\n");
  run(root, ["--docker"]);
  assert.match(root.output(), /Next: run "docker compose up -d", then open http:\/\/192\.168\.0\.92:9000/);
});

test("bad arguments exit 2; a missing .env.example exits 1", () => {
  const root = makeRoot();
  assert.equal(run(root, ["--nope"]), 2);
  assert.equal(run(root, ["--mode", "x"]), 2);
  assert.throws(() => parseArgs(["--mode"]));
  const empty = makeRoot();
  assert.equal(initEnv({ cwd: join(empty.cwd, "nowhere"), argv: [], env: {}, stdout: empty.stdout }), 1);
});

test("--lockdown: hashes match the stored tokens, the plain recovery token stays out of .env and stdout", () => {
  const root = makeRoot();
  assert.equal(run(root, ["--lockdown"]), 0);
  const env = envOf(root);
  const recoveryFile = join(root.cwd, "var/owner-recovery-token.txt");
  const recovery = readFileSync(recoveryFile, "utf8").trim();
  assert.match(recovery, /^[0-9a-f]{64}$/);
  assert.equal(env.OWNER_RECOVERY_TOKEN, sha256Hex(recovery));
  assert.match(env.OPENRHEN_WORKER_TOKEN, /^[0-9a-f]{64}$/);
  assert.equal(env.WORKER_TOKEN_HASH, sha256Hex(env.OPENRHEN_WORKER_TOKEN));
  assert.ok(!readFileSync(join(root.cwd, ".env"), "utf8").includes(recovery));
  const output = root.output();
  assert.ok(!output.includes(recovery));
  assert.ok(!output.includes(env.OPENRHEN_WORKER_TOKEN));
  assert.ok(output.includes("var/owner-recovery-token.txt"));
  assert.equal(env.OPENRHEN_OWNER_AUTH, "off");
  if (process.platform !== "win32") assert.equal(statSync(recoveryFile).mode & 0o777, 0o600);
});

test("sha256Hex matches the portal's encoding (UTF-8 bytes, lowercase hex)", () => {
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(sha256Hex("é"), createHash("sha256").update(Buffer.from("é", "utf8")).digest("hex"));
});

test("--lockdown rerun keeps both pairs and the recovery file", () => {
  const root = makeRoot();
  run(root, ["--lockdown"]);
  const env = readFileSync(join(root.cwd, ".env"), "utf8");
  const recovery = readFileSync(join(root.cwd, "var/owner-recovery-token.txt"), "utf8");
  const second = makeRoot();
  run(root, ["--lockdown"], second.stdout);
  assert.equal(readFileSync(join(root.cwd, ".env"), "utf8"), env);
  assert.equal(readFileSync(join(root.cwd, "var/owner-recovery-token.txt"), "utf8"), recovery);
  assert.match(second.output(), /generated: nothing/);
  assert.ok(!second.output().includes("owner recovery token:"));
});

test("--lockdown warns and changes nothing when only half a pair exists", () => {
  const root = makeRoot();
  writeFileSync(join(root.cwd, ".env"), "OPENRHEN_WORKER_TOKEN=half\n");
  run(root, ["--lockdown"]);
  const env = envOf(root);
  assert.equal(env.OPENRHEN_WORKER_TOKEN, "half");
  assert.ok(!env.WORKER_TOKEN_HASH);
  assert.match(root.output(), /hint: OPENRHEN_WORKER_TOKEN\/WORKER_TOKEN_HASH/);
});

test("a private scalar that Node returns short is padded back to 32 bytes (the 1-in-256 flake)", () => {
  const short = Buffer.alloc(31, 7);
  const padded = padVapidPrivateKey(short);
  assert.equal(padded.length, 32);
  assert.equal(padded[0], 0);
  assert.deepEqual(padded.subarray(1), short);
  assert.equal(padVapidPrivateKey(Buffer.alloc(32, 9)).length, 32);
});
