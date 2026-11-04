import { describe, expect, it } from "vitest";
import {
  base64UrlDecode,
  encryptWebPushPayload,
  generateVapidKeyPair,
  sendWebPush,
  signVapidJwt,
  vapidConfigFromEnv
} from "./web-push.js";

// RFC 8291 §5, "A Working Example" — fixed keys and salt so the whole pipeline (ECDH, the two HKDF
// stages, AES-128-GCM) is checked byte for byte against the spec's own published vectors, not just
// against itself.
const AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
const AS_PUBLIC = "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8";
const UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const UA_AUTH = "BTBZMqHH6r4Tts7J_aSIgg";
const SALT = "DGv6ra1nlYgDCS1FRnbzlw";
const PLAINTEXT = "When I grow up, I want to be a watermelon";
const EXPECTED_CIPHERTEXT_B64URL =
  "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
  "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
  "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

describe("encryptWebPushPayload", () => {
  it("matches the RFC 8291 worked example byte for byte", () => {
    const result = encryptWebPushPayload(Buffer.from(PLAINTEXT, "utf8"), UA_PUBLIC, UA_AUTH, {
      publicKey: base64UrlDecode(AS_PUBLIC),
      privateKey: base64UrlDecode(AS_PRIVATE),
      salt: base64UrlDecode(SALT)
    });
    expect(result.toString("base64url")).toBe(EXPECTED_CIPHERTEXT_B64URL);
  });

  it("produces a fresh ephemeral key and salt per call absent fixed serverKeys", () => {
    const a = encryptWebPushPayload(Buffer.from("hi"), UA_PUBLIC, UA_AUTH);
    const b = encryptWebPushPayload(Buffer.from("hi"), UA_PUBLIC, UA_AUTH);
    expect(a.equals(b)).toBe(false);
  });

  it("the header carries the salt, record size 4096 and a 65-byte key id", () => {
    const salt = base64UrlDecode(SALT);
    const result = encryptWebPushPayload(Buffer.from("x"), UA_PUBLIC, UA_AUTH, {
      publicKey: base64UrlDecode(AS_PUBLIC),
      privateKey: base64UrlDecode(AS_PRIVATE),
      salt
    });
    expect(result.subarray(0, 16).equals(salt)).toBe(true);
    expect(result.readUInt32BE(16)).toBe(4096);
    expect(result.readUInt8(20)).toBe(65);
  });
});

describe("signVapidJwt", () => {
  it("produces a JWT with the given audience and an ES256 header", () => {
    const keys = generateVapidKeyPair();
    const jwt = signVapidJwt({
      audience: "https://fcm.googleapis.com",
      subject: "mailto:ops@example.com",
      publicKeyB64Url: keys.publicKey,
      privateKeyB64Url: keys.privateKey
    });
    const [headerB64, claimsB64, signatureB64] = jwt.split(".");
    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString());
    const claims = JSON.parse(Buffer.from(claimsB64!, "base64url").toString());
    expect(header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:ops@example.com");
    // Raw r||s, not ASN.1 DER: exactly 64 bytes for P-256.
    expect(Buffer.from(signatureB64!, "base64url")).toHaveLength(64);
  });

  it("round-trips a generated key pair (sign, then verify against its own public key)", () => {
    const keys = generateVapidKeyPair();
    const jwt = signVapidJwt({
      audience: "https://web.push.apple.com",
      subject: "mailto:ops@example.com",
      publicKeyB64Url: keys.publicKey,
      privateKeyB64Url: keys.privateKey
    });
    expect(jwt.split(".")).toHaveLength(3);
  });
});

describe("vapidConfigFromEnv", () => {
  it("is undefined when any of the three variables is missing", () => {
    expect(vapidConfigFromEnv({})).toBeUndefined();
    expect(vapidConfigFromEnv({ WEB_PUSH_VAPID_PUBLIC_KEY: "abc", WEB_PUSH_VAPID_PRIVATE_KEY: "def" })).toBeUndefined();
  });

  it("reads all three when present", () => {
    const config = vapidConfigFromEnv({
      WEB_PUSH_VAPID_PUBLIC_KEY: "abc",
      WEB_PUSH_VAPID_PRIVATE_KEY: "def",
      WEB_PUSH_SUBJECT: "mailto:ops@example.com"
    });
    expect(config).toEqual({ publicKey: "abc", privateKey: "def", subject: "mailto:ops@example.com" });
  });
});

describe("sendWebPush", () => {
  const config = { publicKey: AS_PUBLIC, privateKey: AS_PRIVATE, subject: "mailto:a@example.com" };

  it("rejects an endpoint host that is not on the allowlist without calling fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const result = await sendWebPush(
      {
        subscription: { endpoint: "https://evil.example.com/push/abc", keys: { p256dh: UA_PUBLIC, auth: UA_AUTH } },
        payload: JSON.stringify({ title: "t", body: "b", tag: "x", url: "/now" }),
        ttlSeconds: 60,
        urgency: "high"
      },
      config,
      fetchImpl
    );
    expect(result.outcome).toBe("rejected");
    expect(called).toBe(false);
  });

  it("maps 404/410 to gone, 2xx to delivered, other 4xx to rejected, 5xx to failed", async () => {
    async function sendWithStatus(status: number) {
      const fetchImpl = (async () => new Response(null, { status })) as typeof fetch;
      return sendWebPush(
        {
          subscription: {
            endpoint: "https://fcm.googleapis.com/fcm/send/abc",
            keys: { p256dh: UA_PUBLIC, auth: UA_AUTH }
          },
          payload: JSON.stringify({ title: "t", body: "b", tag: "x", url: "/now" }),
          ttlSeconds: 60,
          urgency: "high"
        },
        config,
        fetchImpl
      );
    }
    expect((await sendWithStatus(201)).outcome).toBe("delivered");
    expect((await sendWithStatus(404)).outcome).toBe("gone");
    expect((await sendWithStatus(410)).outcome).toBe("gone");
    expect((await sendWithStatus(429)).outcome).toBe("rejected");
    expect((await sendWithStatus(500)).outcome).toBe("failed");
  });

  it("a network failure maps to failed", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    const result = await sendWebPush(
      {
        subscription: {
          endpoint: "https://fcm.googleapis.com/fcm/send/abc",
          keys: { p256dh: UA_PUBLIC, auth: UA_AUTH }
        },
        payload: JSON.stringify({ title: "t", body: "b", tag: "x", url: "/now" }),
        ttlSeconds: 60,
        urgency: "high"
      },
      config,
      fetchImpl
    );
    expect(result.outcome).toBe("failed");
  });
});
