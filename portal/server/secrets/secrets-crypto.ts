import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Sealing for the passwords and keys the person types into the app (Settings, Passwords and keys). AES-256-GCM
 * under `OPENRHEN_SECRETS_KEY` (32 random bytes, base64, the portal's environment only), a fresh random 96-bit nonce
 * per sealing, and the user id, secret name and key version bound as additional authenticated data so a row copied
 * to another user or name cannot be opened.
 *
 * This protects a database dump, a backup or SQL access. It does not protect against a compromised portal process
 * (which holds the key) or `docker inspect` (which shows the variable). A value that cannot be opened is reported as
 * `unreadable`; nothing here logs a plaintext, a ciphertext or the key.
 */

export const SECRETS_KEY_ENV = "OPENRHEN_SECRETS_KEY";
/** The key version written today. A rotation scheme would bump this; for now, rotating means entering keys again. */
export const CURRENT_KEY_VERSION = 1;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type MasterKey = { status: "ok"; key: Buffer } | { status: "missing" } | { status: "invalid"; reason: string };

/** Reads the master key from `env`. The answer never contains the value it was given. */
export function loadMasterKey(env: Record<string, string | undefined> = process.env): MasterKey {
  const raw = env[SECRETS_KEY_ENV]?.trim();
  if (!raw) return { status: "missing" };
  if (!BASE64.test(raw) || raw.length % 4 !== 0)
    return { status: "invalid", reason: `${SECRETS_KEY_ENV} is not base64.` };
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES)
    return {
      status: "invalid",
      reason: `${SECRETS_KEY_ENV} decodes to ${key.length} bytes; it must be exactly ${KEY_BYTES} (try \`openssl rand -base64 32\`).`
    };
  if (key.every((byte) => byte === key[0]))
    return {
      status: "invalid",
      reason: `${SECRETS_KEY_ENV} is the same byte repeated, which looks like a typo or a placeholder; make a real key with \`openssl rand -base64 32\`.`
    };
  return { status: "ok", key };
}

export interface SecretContext {
  userId: string;
  name: string;
  keyVersion: number;
}

export interface SealedSecret {
  /** base64 of the ciphertext followed by the 16-byte GCM tag. */
  ciphertext: string;
  /** base64 of the 12-byte nonce. */
  nonce: string;
}

const additionalData = (context: SecretContext) =>
  Buffer.from(`${context.userId}|${context.name}|${context.keyVersion}`, "utf8");

export function encryptSecret(key: Buffer, context: SecretContext, plaintext: string): SealedSecret {
  if (key.length !== KEY_BYTES) throw new Error(`The secrets key must be ${KEY_BYTES} bytes.`);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData(context));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return { ciphertext: body.toString("base64"), nonce: nonce.toString("base64") };
}

export type DecryptedSecret = { kind: "ok"; value: string } | { kind: "unreadable" };

/** Opens a sealed value. Any failure (wrong key, tampering, wrong user or name, malformed input) is `unreadable`. */
export function decryptSecret(key: Buffer, context: SecretContext, sealed: SealedSecret): DecryptedSecret {
  try {
    if (key.length !== KEY_BYTES) return { kind: "unreadable" };
    const nonce = Buffer.from(sealed.nonce, "base64");
    const body = Buffer.from(sealed.ciphertext, "base64");
    if (nonce.length !== NONCE_BYTES || body.length < TAG_BYTES) return { kind: "unreadable" };
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(additionalData(context));
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]);
    return { kind: "ok", value: plain.toString("utf8") };
  } catch {
    return { kind: "unreadable" };
  }
}
