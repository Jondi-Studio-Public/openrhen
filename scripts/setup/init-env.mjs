#!/usr/bin/env node
// Creates or completes `.env` without a secrets manager: copies `.env.example` when `.env` is absent, then
// generates every secret that is blank or still `replace-before-lan-use`. Never overwrites a value
// you set, never prints a value (names only), and a second run generates nothing.
//
//   node scripts/setup/init-env.mjs [--mode docker|source] [--docker] [--lockdown]
//   docker compose run --rm setup            (passes --docker)
//
//   --mode docker   (default) DATABASE_URL hosts are `postgres`, the bundled service.
//   --mode source   hosts are 127.0.0.1:${POSTGRES_HOST_PORT}, to run `corepack pnpm dev`.
//   --docker        running as root in the setup container: chown var/photos and .env, keep UTC.
//   Add-on env fragments (`addons/<id>/env.example`) are folded into .env too; format in addon-env.mjs.
//   --lockdown      also make the worker token pair and the owner recovery token (for OPENRHEN_OWNER_AUTH=require);
//                   the plain recovery token goes to var/owner-recovery-token.txt, never .env or stdout.
//
// Exports:
//   GENERATED                          -> string[]   hex-token keys filled when blank/placeholder
//   VAPID_KEYS                         -> string[]   the Web Push key pair
//   generateVapidKeys()                -> { publicKey, privateKey }   base64url, 65 and 32 bytes
//   parseArgs(argv)                    -> { mode, docker, lockdown }   throws on an unknown flag or mode
//   sha256Hex(text)                    -> string   lowercase hex of the UTF-8 bytes, what the portal compares
//   applyLockdown({ cwd, text })       -> { text, generated, kept, warnings, recoveryPath }
//   initEnv({ cwd, argv, env, stdout }) -> number    exit code; the testable entry point
//   ensureEnvFile(ctx)                 -> { text, created }   building block for --lockdown
import { createECDH, createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLACEHOLDER } from "../deploy/required-secrets.mjs";
import { applyAddonEnv } from "./addon-env.mjs";
import { getValue, isBlank, parseEnvText, setValue } from "./env-file.mjs";

export const GENERATED = [
  "POSTGRES_PASSWORD",
  "PLAN_FORECAST_SERVICE_TOKEN",
  "OUTBOUND_PROXY_TOKEN",
  "LOCATION_PING_TOKEN"
];
export const VAPID_KEYS = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY"];
const URL_KEYS = ["DATABASE_URL", "POSTGRES_ADMIN_URL"];
const PASSWORD_TOKEN = "__POSTGRES_PASSWORD__";
const NODE_UID = 1000;

function base64UrlEncode(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// Same encoder as integrations/outbound-proxy/scripts/generate-vapid-keys.mjs (duplicated on
// purpose: scripts/ takes no dependency on the proxy package).
// Node returns the private scalar without its leading zero bytes (about 1 key in 256 is 31 bytes); a VAPID
// private key is always 32, so pad it back.
export function padVapidPrivateKey(scalar) {
  return Buffer.concat([Buffer.alloc(Math.max(0, 32 - scalar.length)), scalar]);
}

export function generateVapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    publicKey: base64UrlEncode(ecdh.getPublicKey()),
    privateKey: base64UrlEncode(padVapidPrivateKey(ecdh.getPrivateKey()))
  };
}

export function parseArgs(argv) {
  const options = { mode: "docker", docker: false, lockdown: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--docker") options.docker = true;
    else if (arg === "--lockdown") options.lockdown = true;
    else if (arg === "--mode") options.mode = argv[++i];
    else if (arg.startsWith("--mode=")) options.mode = arg.slice("--mode=".length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.mode !== "docker" && options.mode !== "source") {
    throw new Error(`--mode must be docker or source, got ${options.mode ?? "nothing"}.`);
  }
  return options;
}

/** Lowercase hex sha256 of the UTF-8 bytes: what `portal/server/owner-auth.ts` compares. */
export function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const RECOVERY_FILE = "var/owner-recovery-token.txt";
const LOCKDOWN_PAIRS = [
  { plain: "OPENRHEN_WORKER_TOKEN", stored: "WORKER_TOKEN_HASH" },
  { plain: null, stored: "OWNER_RECOVERY_TOKEN" }
];

/**
 * Generates the lockdown secrets for `.env` on any platform. Makes the worker token and
 * its hash, and the owner recovery hash (the plain token goes to `var/owner-recovery-token.txt`,
 * mode 0600, not `.env`). A pair that exists is skipped, so a rerun never overwrites a secret. It
 * never touches OPENRHEN_OWNER_AUTH.
 */
export function applyLockdown({ cwd, text }) {
  const generated = [];
  const kept = [];
  const warnings = [];
  let recoveryPath = null;
  for (const { plain, stored } of LOCKDOWN_PAIRS) {
    const haveStored = !isBlank(getValue(text, stored));
    const havePlain = plain ? !isBlank(getValue(text, plain)) : haveStored;
    if (haveStored && havePlain) {
      kept.push(...(plain ? [plain, stored] : [stored]));
      continue;
    }
    if (haveStored || havePlain) {
      warnings.push(`${plain}/${stored}: only one is set. Blank it in .env and rerun, so the pair matches.`);
      continue;
    }
    const token = randomBytes(32).toString("hex");
    if (plain) {
      text = setValue(text, plain, token);
      generated.push(plain);
    } else {
      mkdirSync(join(cwd, "var"), { recursive: true });
      recoveryPath = join(cwd, RECOVERY_FILE);
      writeFileSync(recoveryPath, `${token}\n`, { mode: 0o600 });
      try {
        chmodSync(recoveryPath, 0o600);
      } catch {
        // No POSIX modes on this platform.
      }
    }
    text = setValue(text, stored, sha256Hex(token));
    generated.push(stored);
  }
  return { text, generated, kept, warnings, recoveryPath };
}

const needsValue = (value) => isBlank(value) || value.trim() === PLACEHOLDER;

/** Copies `.env.example` to `.env` when `.env` is absent. Returns the current `.env` text. */
export function ensureEnvFile({ cwd }) {
  const envPath = join(cwd, ".env");
  const created = !existsSync(envPath);
  if (created) {
    const example = join(cwd, ".env.example");
    if (!existsSync(example)) throw new Error(".env.example not found; run this from the repository root.");
    copyFileSync(example, envPath);
  }
  return { text: readFileSync(envPath, "utf8"), created };
}

export function initEnv({
  cwd = process.cwd(),
  argv = process.argv.slice(2),
  env: _env = process.env, // accepted for symmetry with check-env and for --lockdown
  stdout = process.stdout
} = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    stdout.write(`init-env: ${error.message}\n`);
    return 2;
  }
  let text;
  let created;
  try {
    ({ text, created } = ensureEnvFile({ cwd }));
  } catch (error) {
    stdout.write(`init-env: ${error.message}\n`);
    return 1;
  }
  const generated = [];
  const kept = [];

  for (const key of GENERATED) {
    const current = getValue(text, key);
    if (needsValue(current)) {
      text = setValue(text, key, randomBytes(32).toString("hex"));
      generated.push(key);
    } else kept.push(key);
  }

  const addon = applyAddonEnv({ cwd, text });
  ({ text } = addon);
  generated.push(...addon.generated);
  kept.push(...addon.kept);

  const values = parseEnvText(text);
  if (VAPID_KEYS.some((key) => isBlank(values[key]))) {
    const { publicKey, privateKey } = generateVapidKeys();
    // A half-set pair is useless, so a blank in either side regenerates both.
    text = setValue(setValue(text, VAPID_KEYS[0], publicKey), VAPID_KEYS[1], privateKey);
    generated.push(...VAPID_KEYS);
  } else kept.push(...VAPID_KEYS);
  if (isBlank(getValue(text, "WEB_PUSH_SUBJECT"))) {
    text = setValue(text, "WEB_PUSH_SUBJECT", "mailto:admin@localhost");
    generated.push("WEB_PUSH_SUBJECT");
  }

  // Database URLs: fill the password token, and in source mode point them at the published port.
  const password = getValue(text, "POSTGRES_PASSWORD");
  const hostPort = (getValue(text, "POSTGRES_HOST_PORT") || "55432").trim();
  for (const key of URL_KEYS) {
    let url = getValue(text, key);
    if (url === undefined) continue;
    let next = url.replaceAll(PASSWORD_TOKEN, password);
    if (options.mode === "source") next = next.replace(/@postgres:5432\b/, `@127.0.0.1:${hostPort}`);
    if (next !== url) {
      text = setValue(text, key, next);
      generated.push(key);
    }
  }

  const hints = [];
  const zone = getValue(text, "APP_TIMEZONE");
  if (options.docker) {
    if (created || isBlank(zone))
      hints.push(
        "APP_TIMEZONE is UTC until you set it in .env (an IANA zone such as Europe/London); the first-run screen in the portal also asks for your timezone."
      );
  } else if (created || isBlank(zone)) {
    const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (hostZone) {
      text = setValue(text, "APP_TIMEZONE", hostZone);
      generated.push("APP_TIMEZONE");
    }
  }

  hints.push(...addon.conflicts);

  let recoveryPath = null;
  if (options.lockdown) {
    const result = applyLockdown({ cwd, text });
    ({ text, recoveryPath } = result);
    generated.push(...result.generated);
    kept.push(...result.kept);
    hints.push(...result.warnings);
  }

  const envPath = join(cwd, ".env");
  writeFileSync(envPath, text);
  for (const dir of ["var/photos", "var/backups", "var/backups/pre-migrate"]) {
    mkdirSync(join(cwd, dir), { recursive: true });
  }
  try {
    chmodSync(envPath, 0o600);
  } catch {
    // Platforms without POSIX modes (Windows) skip this.
  }
  if (options.docker && typeof process.getuid === "function" && process.getuid() === 0) {
    try {
      chownSync(join(cwd, "var/photos"), NODE_UID, NODE_UID);
      const owner = statSync(cwd);
      chownSync(envPath, owner.uid, owner.gid);
      if (recoveryPath) chownSync(recoveryPath, owner.uid, owner.gid);
    } catch (error) {
      hints.push(
        `Could not change file ownership (${error.code ?? "error"}); photo upload or reading .env may need a chown.`
      );
    }
  }

  stdout.write(`init-env: ${created ? "created .env from .env.example" : "using existing .env"}.\n`);
  stdout.write(`generated: ${generated.length ? generated.join(", ") : "nothing"}\n`);
  if (kept.length) stdout.write(`kept: ${kept.join(", ")}\n`);
  if (recoveryPath) {
    stdout.write(
      `owner recovery token: ${recoveryPath}\nStore it in your password manager, then delete the file. Then set OPENRHEN_OWNER_AUTH=require, restart, and sign in with it.\n`
    );
  }
  for (const hint of hints) stdout.write(`hint: ${hint}\n`);
  if (options.docker && !options.lockdown) {
    const port = (getValue(text, "PORTAL_PORT") || "8787").trim();
    const bound = (getValue(text, "PORTAL_HOST_IP") || "").trim();
    const host = !bound || bound === "0.0.0.0" || bound === "127.0.0.1" ? "localhost" : bound;
    stdout.write(
      `Next: run "docker compose up -d", then open http://${host}:${port}. The first start builds the images, which takes a few minutes.\n`
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = initEnv({
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    env: process.env,
    stdout: process.stdout
  });
}
