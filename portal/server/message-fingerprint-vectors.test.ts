import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalMessageKey, messageFingerprint, sha256Hex } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

interface Vectors {
  version: number;
  fingerprints: { name: string; from: string; text: string; fp: string }[];
  keys: { name: string; message_id?: string; from?: string; start?: string; text?: string; key: string }[];
}
const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../platform/contracts/message-fingerprint-vectors.v1.json", import.meta.url)),
    "utf8"
  )
) as Vectors;

describe("the frozen message@1 fingerprint and key vectors", () => {
  it("are version 1 and cover every rule", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.fingerprints.length).toBeGreaterThanOrEqual(9);
    expect(vectors.keys.length).toBeGreaterThanOrEqual(4);
  });

  it.each(vectors.fingerprints)("fingerprint: $name", ({ from, text, fp }) => {
    expect(messageFingerprint(from, text)).toBe(fp);
  });

  it.each(vectors.keys)("key: $name", (row) => {
    expect(
      canonicalMessageKey({
        messageId: row.message_id,
        sender: row.from ?? "x",
        tsStart: new Date(row.start ?? "2026-01-01T00:00:00Z"),
        content: row.text ?? null
      })
    ).toBe(row.key);
  });

  it("are sha256 as Node computes it: fp is the first 32 hex over the JSON of (sender, text), the fp: key 40 over (sender, minute, text)", () => {
    const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    expect(messageFingerprint("alex@example.com", "Hello world")).toBe(
      hash(["alex@example.com", "hello world"]).slice(0, 32)
    );
    expect(
      canonicalMessageKey({
        sender: "alex@example.com",
        tsStart: new Date("2026-11-08T10:15:42Z"),
        content: "Hello world"
      })
    ).toBe(`fp:${hash(["alex@example.com", "2026-11-08T10:15:00.000Z", "hello world"]).slice(0, 40)}`);
    for (const text of ["", "abc", "a".repeat(1000), "é☕"])
      expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
  });
});
