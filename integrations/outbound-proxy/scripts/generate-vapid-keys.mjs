#!/usr/bin/env node
// Prints a fresh VAPID key pair in .env form.
//
// Plain Node, no TS loader: this is a one-shot operator tool, run directly with
// `node integrations/outbound-proxy/scripts/generate-vapid-keys.mjs`, not imported by anything, so
// it duplicates the tiny base64url encode rather than reaching into the compiled proxy for it.
import { createECDH } from "node:crypto";

function base64UrlEncode(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const publicKey = base64UrlEncode(ecdh.getPublicKey());
// Node drops leading zero bytes of the scalar (about 1 key in 256); a VAPID private key is always 32 bytes.
const scalar = ecdh.getPrivateKey();
const privateKey = base64UrlEncode(Buffer.concat([Buffer.alloc(Math.max(0, 32 - scalar.length)), scalar]));

process.stdout.write(
  [
    "# Paste into the outbound proxy's .env (never the portal's) — see docs/operations/web-push.md.",
    `WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`,
    `WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`,
    "WEB_PUSH_SUBJECT=mailto:you@example.com",
    ""
  ].join("\n")
);
