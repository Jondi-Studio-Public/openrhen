import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { isAllowedPushEndpoint, type PushSendOutcome, type PushSendRequest } from "@openrhen/contracts";

/**
 * Standard Web Push, hand-written on Node `crypto` (the leave by push design note, "Push
 * transport"): VAPID (RFC 8292) for the sender's identity and `aes128gcm` (RFC 8291 over RFC 8188)
 * for the payload. No `web-push` dependency — every third-party HTTPS call goes through this proxy,
 * and the RFC 8291 worked example (its own test vectors) pins this code against a spec, not a guess.
 */

const B64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

function base64UrlEncode(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Buffer {
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Buffer.from(padded, "base64");
}

export interface VapidKeyPair {
  /** Uncompressed P-256 point, base64url — what the browser's `applicationServerKey` wants. */
  publicKey: string;
  /** PKCS#8, base64url — this proxy's own storage/env format. */
  privateKey: string;
}

/** `scripts/generate-vapid-keys.mjs` calls this; also used directly by tests. */
export function generateVapidKeyPair(): VapidKeyPair {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publicKey = base64UrlEncode(ecdh.getPublicKey());
  // Wrapped as PKCS#8 SEC1 via the `crypto.createPrivateKey`/`sec1` route below at load time, so the
  // stored value round-trips through `vapidPrivateKeyFromRaw`. Keep the raw scalar here, base64url,
  // matching every other web-push implementation's `.env` convention.
  // Node drops leading zero bytes of the scalar (about 1 key in 256); a VAPID private key is always 32 bytes.
  const scalar = ecdh.getPrivateKey();
  const privateKey = base64UrlEncode(Buffer.concat([Buffer.alloc(Math.max(0, 32 - scalar.length)), scalar]));
  return { publicKey, privateKey };
}

/** Rebuilds a Node `KeyObject` from the raw base64url private scalar `generateVapidKeyPair` prints. */
function vapidPrivateKeyFromRaw(rawPrivateKeyB64Url: string) {
  const d = base64UrlDecode(rawPrivateKeyB64Url);
  // A minimal SEC1 EC private key DER wrapper for the P-256 scalar, since Node's `createPrivateKey`
  // has no "raw scalar" input format for EC keys. Deriving the public point from `d` via `createECDH`
  // and embedding it (tag 0x04, context [1]) makes this an unambiguous, versioned SEC1 key rather
  // than relying on optional-field inference.
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(d);
  const q = ecdh.getPublicKey();
  const der = sec1Der(d, q);
  return createPrivateKey({ key: der, format: "der", type: "sec1" });
}

/** Builds a SEC1 `ECPrivateKey` DER structure: version 1, the 32-byte scalar, curve OID, the point. */
function sec1Der(privateScalar: Buffer, publicPoint: Buffer): Buffer {
  const P256_OID = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07]);
  function tlv(tag: number, content: Buffer): Buffer {
    if (content.length < 0x80) return Buffer.concat([Buffer.from([tag, content.length]), content]);
    const lenBytes: number[] = [];
    let len = content.length;
    while (len > 0) {
      lenBytes.unshift(len & 0xff);
      len >>= 8;
    }
    return Buffer.concat([Buffer.from([tag, 0x80 | lenBytes.length, ...lenBytes]), content]);
  }
  const version = tlv(0x02, Buffer.from([0x01]));
  const privKey = tlv(0x04, privateScalar);
  const params = tlv(0xa0, P256_OID);
  const pubKey = tlv(0xa1, tlv(0x03, Buffer.concat([Buffer.from([0x00]), publicPoint])));
  return tlv(0x30, Buffer.concat([version, privKey, params, pubKey]));
}

function base64UrlFromJson(value: unknown): string {
  return base64UrlEncode(Buffer.from(JSON.stringify(value)));
}

/**
 * The VAPID Authorization header value (RFC 8292): an ES256 JWT whose `aud` is the push endpoint's
 * own origin, signed with this proxy's VAPID private key, plus the public key as `k=`. Cached by the
 * caller per audience, not here — this function is pure given its inputs.
 */
export function signVapidJwt(input: {
  audience: string;
  subject: string;
  publicKeyB64Url: string;
  privateKeyB64Url: string;
  now?: Date;
  ttlSeconds?: number;
}): string {
  const now = input.now ?? new Date();
  const exp = Math.floor(now.getTime() / 1000) + (input.ttlSeconds ?? 12 * 60 * 60);
  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: input.audience, exp, sub: input.subject };
  const signingInput = `${base64UrlFromJson(header)}.${base64UrlFromJson(claims)}`;
  const privateKey = vapidPrivateKeyFromRaw(input.privateKeyB64Url);
  // `dsaEncoding: "ieee-p1363"` is the raw r||s (64 bytes) a JWS wants; Node's default is ASN.1 DER.
  const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF-Expand (RFC 5869), single iteration — every length used here is ≤ 32 bytes. */
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  return hmacSha256(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

const RECORD_SIZE = 4096;

/**
 * `aes128gcm`-encrypts one Web Push payload (RFC 8291 over RFC 8188's single-record framing).
 * `serverKeys` lets the RFC 8291 worked example's own fixed ephemeral keypair and salt be passed in
 * by the test that checks this function byte-for-byte against the spec; real sends generate fresh
 * ones every time.
 */
export function encryptWebPushPayload(
  payload: Buffer,
  p256dhB64Url: string,
  authB64Url: string,
  serverKeys?: { publicKey: Buffer; privateKey: Buffer; salt: Buffer }
): Buffer {
  const clientPublicKey = base64UrlDecode(p256dhB64Url);
  const authSecret = base64UrlDecode(authB64Url);

  const ecdh = createECDH("prime256v1");
  if (serverKeys) ecdh.setPrivateKey(serverKeys.privateKey);
  else ecdh.generateKeys();
  const serverPublicKey = serverKeys?.publicKey ?? ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPublicKey);
  const salt = serverKeys?.salt ?? randomBytes(16);

  // Step 1 (RFC 8291 §3.3): derive an IKM shared between the two parties, keyed by the client's own
  // auth secret so a stolen ECDH share alone cannot forge a message.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "ascii"), clientPublicKey, serverPublicKey]);
  const prkCombine = hmacSha256(authSecret, sharedSecret);
  const ikm = hkdfExpand(prkCombine, keyInfo, 32);

  // Step 2 (RFC 8188 §2.1): the per-message content-encryption key and nonce, keyed by this
  // message's own random salt.
  const prk = hmacSha256(salt, ikm);
  const cek = hkdfExpand(prk, Buffer.from("Content-Encoding: aes128gcm\0", "ascii"), 16);
  const nonce = hkdfExpand(prk, Buffer.from("Content-Encoding: nonce\0", "ascii"), 12);

  // Single record: no chunking, since every leave-by payload is well under RECORD_SIZE. The `0x02`
  // delimiter marks it as the (only, so also last) record; RFC 8188 padding is unused here.
  const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1 + serverPublicKey.length);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublicKey.length, 20);
  serverPublicKey.copy(header, 21);

  return Buffer.concat([header, ciphertext]);
}

export interface VapidEnvConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** `WEB_PUSH_VAPID_PUBLIC_KEY`/`WEB_PUSH_VAPID_PRIVATE_KEY`/`WEB_PUSH_SUBJECT`, the proxy's own env. */
export function vapidConfigFromEnv(env: Record<string, string | undefined> = process.env): VapidEnvConfig | undefined {
  const publicKey = env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = env.WEB_PUSH_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return undefined;
  if (!B64URL_ALPHABET.test(publicKey) || !B64URL_ALPHABET.test(privateKey)) return undefined;
  return { publicKey, privateKey, subject };
}

/** One VAPID JWT per audience (push service origin), cached up to an hour, well under its 12h `exp`. */
const vapidJwtCache = new Map<string, { jwt: string; expiresAt: number }>();
const VAPID_CACHE_MS = 60 * 60 * 1000;

function vapidAuthorizationHeader(audience: string, config: VapidEnvConfig, now: Date): string {
  const cached = vapidJwtCache.get(audience);
  if (cached && cached.expiresAt > now.getTime()) return `vapid t=${cached.jwt}, k=${config.publicKey}`;
  const jwt = signVapidJwt({
    audience,
    subject: config.subject.startsWith("mailto:") ? config.subject : `mailto:${config.subject}`,
    publicKeyB64Url: config.publicKey,
    privateKeyB64Url: config.privateKey,
    now
  });
  vapidJwtCache.set(audience, { jwt, expiresAt: now.getTime() + VAPID_CACHE_MS });
  return `vapid t=${jwt}, k=${config.publicKey}`;
}

export class WebPushError extends Error {
  constructor(
    message: string,
    public readonly outcome: PushSendOutcome
  ) {
    super(message);
  }
}

/**
 * `POST /push/send`'s implementation: encrypts, signs and sends one push. The endpoint host has
 * already been checked against the allowlist by the caller (the route), but this function checks it
 * again defensively — it must never become an open outbound fetch no matter how it is called.
 */
export async function sendWebPush(
  request: PushSendRequest,
  config: VapidEnvConfig,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date()
): Promise<{ outcome: PushSendOutcome; httpStatus?: number }> {
  if (!isAllowedPushEndpoint(request.subscription.endpoint)) return { outcome: "rejected" };
  const endpointUrl = new URL(request.subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const body = encryptWebPushPayload(
    Buffer.from(request.payload, "utf8"),
    request.subscription.keys.p256dh,
    request.subscription.keys.auth
  );
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    ttl: String(request.ttlSeconds),
    urgency: request.urgency,
    authorization: vapidAuthorizationHeader(audience, config, now)
  };
  if (request.topic) headers.topic = request.topic;

  let response: Response;
  try {
    response = await fetchImpl(request.subscription.endpoint, {
      method: "POST",
      headers,
      body: new Uint8Array(body)
    });
  } catch {
    return { outcome: "failed" };
  }
  if (response.status === 404 || response.status === 410) return { outcome: "gone", httpStatus: response.status };
  if (response.status >= 200 && response.status < 300) return { outcome: "delivered", httpStatus: response.status };
  if (response.status >= 400 && response.status < 500) return { outcome: "rejected", httpStatus: response.status };
  return { outcome: "failed", httpStatus: response.status };
}

export { base64UrlDecode, base64UrlEncode };
