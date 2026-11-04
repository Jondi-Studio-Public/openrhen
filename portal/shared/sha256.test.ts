import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

/** Hides `crypto.subtle`, as a plain-http origin does, so the pure-JS path is the one exercised. */
async function withoutSubtle<T>(body: () => Promise<T>): Promise<T> {
  Object.defineProperty(globalThis.crypto, "subtle", { value: undefined, configurable: true });
  try {
    return await body();
  } finally {
    delete (globalThis.crypto as { subtle?: unknown }).subtle;
  }
}

const bytes = (length: number, seed = 1) =>
  Uint8Array.from({ length }, (_, index) => (index * 31 + seed * 17 + (index % 7)) % 256);

describe("sha256Hex", () => {
  it("matches the published digests for the standard test vectors", async () => {
    expect(await sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });

  /**
   * The digest is stored and compared against later uploads, so the fallback agreeing with the real
   * implementation is the whole point: a file read over http must fingerprint exactly as it does
   * over https. The lengths cover the padding boundaries, where a hand-written SHA-256 goes wrong.
   */
  it("agrees with crypto.subtle at every padding boundary and beyond", async () => {
    for (const length of [0, 1, 3, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1000, 100_000]) {
      const input = bytes(length);
      const reference = await sha256Hex(input);
      const fallback = await withoutSubtle(() => sha256Hex(input));
      expect(`${length}: ${fallback}`).toBe(`${length}: ${reference}`);
    }
  });

  it("separates inputs that differ only in one byte or in length", async () => {
    const [a, b, longer] = [bytes(64, 1), bytes(64, 2), bytes(65, 1)];
    const digests = await withoutSubtle(async () => [await sha256Hex(a), await sha256Hex(b), await sha256Hex(longer)]);
    expect(new Set(digests).size).toBe(3);
    expect(digests.every((digest) => /^[0-9a-f]{64}$/.test(digest))).toBe(true);
  });
});
