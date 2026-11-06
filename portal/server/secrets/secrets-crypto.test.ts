import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret, loadMasterKey, SECRETS_KEY_ENV } from "./secrets-crypto";

const key = randomBytes(32);
const env = (value: string | undefined) => ({ [SECRETS_KEY_ENV]: value });
const aad = { userId: "11111111-1111-4111-8111-111111111111", name: "youtube_data_api_key", keyVersion: 1 };

describe("loadMasterKey", () => {
  it("accepts 32 random bytes as base64", () => {
    const loaded = loadMasterKey(env(key.toString("base64")));
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") expect(loaded.key.equals(key)).toBe(true);
  });

  it("reports an unset or blank key as missing", () => {
    expect(loadMasterKey(env(undefined)).status).toBe("missing");
    expect(loadMasterKey(env("   ")).status).toBe("missing");
  });

  it("rejects a key of the wrong length or that is not base64, without echoing it", () => {
    for (const bad of [
      randomBytes(16).toString("base64"),
      randomBytes(33).toString("base64"),
      "not base64 !!",
      "short"
    ]) {
      const loaded = loadMasterKey(env(bad));
      expect(loaded.status, bad).toBe("invalid");
      expect(JSON.stringify(loaded)).not.toContain(bad);
    }
  });

  it("rejects a key whose bytes are all the same (a typo or placeholder), without echoing it", () => {
    for (const byte of [0, 7, 255]) {
      const bad = Buffer.alloc(32, byte).toString("base64");
      const loaded = loadMasterKey(env(bad));
      expect(loaded.status, String(byte)).toBe("invalid");
      if (loaded.status === "invalid") expect(loaded.reason).toContain("openssl rand -base64 32");
      expect(JSON.stringify(loaded)).not.toContain(bad);
    }
  });
});

describe("encryptSecret and decryptSecret", () => {
  it("round-trips a value and never stores it as text", () => {
    const sealed = encryptSecret(key, aad, "fakeytExampleKey-123");
    expect(sealed.ciphertext).not.toContain("fakeytExampleKey");
    expect(Buffer.from(sealed.nonce, "base64")).toHaveLength(12);
    expect(decryptSecret(key, aad, sealed)).toEqual({ kind: "ok", value: "fakeytExampleKey-123" });
  });

  it("uses a fresh random nonce each time, so the same value seals differently", () => {
    const first = encryptSecret(key, aad, "same");
    const second = encryptSecret(key, aad, "same");
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("is unreadable under a different master key", () => {
    const sealed = encryptSecret(key, aad, "v");
    expect(decryptSecret(randomBytes(32), aad, sealed)).toEqual({ kind: "unreadable" });
  });

  it("binds the user, the name and the key version, so a copied row cannot be opened", () => {
    const sealed = encryptSecret(key, aad, "v");
    expect(decryptSecret(key, { ...aad, userId: "22222222-2222-4222-8222-222222222222" }, sealed).kind).toBe(
      "unreadable"
    );
    expect(decryptSecret(key, { ...aad, name: "other_key" }, sealed).kind).toBe("unreadable");
    expect(decryptSecret(key, { ...aad, keyVersion: 2 }, sealed).kind).toBe("unreadable");
  });

  it("is unreadable when the ciphertext or the nonce has been tampered with or is malformed", () => {
    const sealed = encryptSecret(key, aad, "v");
    const flipped = Buffer.from(sealed.ciphertext, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(decryptSecret(key, aad, { ...sealed, ciphertext: flipped.toString("base64") }).kind).toBe("unreadable");
    expect(decryptSecret(key, aad, { ...sealed, nonce: randomBytes(12).toString("base64") }).kind).toBe("unreadable");
    expect(decryptSecret(key, aad, { ciphertext: "", nonce: "" }).kind).toBe("unreadable");
    expect(decryptSecret(key, aad, { ...sealed, nonce: "AAAA" }).kind).toBe("unreadable");
  });

  it("never logs the plaintext or the ciphertext when decryption fails", () => {
    const sealed = encryptSecret(key, aad, "TOP-SECRET-VALUE");
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {})
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    decryptSecret(randomBytes(32), aad, sealed);
    const written = [...spies.flatMap((spy) => spy.mock.calls), ...stderr.mock.calls].flat().join(" ");
    expect(written).not.toContain("TOP-SECRET-VALUE");
    expect(written).not.toContain(sealed.ciphertext);
    for (const spy of spies) spy.mockRestore();
    stderr.mockRestore();
  });

  it("refuses to seal with a key of the wrong length", () => {
    expect(() => encryptSecret(randomBytes(16), aad, "v")).toThrow(/32 bytes/);
  });
});
