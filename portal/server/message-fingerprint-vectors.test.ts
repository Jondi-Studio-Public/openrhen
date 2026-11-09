import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { canonicalMessageKey, messageFingerprint, sha256Hex } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

interface Vectors {
  version: number;
  fingerprints: { name: string; from: string; text?: string; text_repeat?: [string, number]; fp: string | null }[];
  keys: { name: string; message_id?: string; from?: string; start?: string; text?: string; key: string }[];
}
const raw = readFileSync(
  fileURLToPath(new URL("../../platform/contracts/message-fingerprint-vectors.v1.json", import.meta.url))
);
const vectors = JSON.parse(raw.toString("utf8")) as Vectors;
/** sha256 of the vectors file as published. A change here is a change to every stored fingerprint: bump the contract, do not just update this. */
const VECTORS_FILE_SHA256 = "1a172d81d40cb627a56238f3600b86b24e37a7eb08ca59e2c550437d5916ab5f";

describe("the frozen message@1 fingerprint and key vectors", () => {
  it("are version 1 and cover every rule", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.fingerprints.length).toBeGreaterThanOrEqual(17);
    expect(vectors.keys.length).toBeGreaterThanOrEqual(7);
  });

  it("are frozen: the file's sha256 is pinned", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(VECTORS_FILE_SHA256);
  });

  it.each(vectors.fingerprints)("fingerprint: $name", ({ from, text, text_repeat, fp }) => {
    const input = text_repeat ? text_repeat[0].repeat(text_repeat[1]) : (text ?? "");
    expect(messageFingerprint(from, input)).toBe(fp ?? undefined);
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

  it("serialise non-ASCII as UTF-8 text, not as \\u escapes (Python needs ensure_ascii=False)", () => {
    const array = JSON.stringify(["\u00e9lodie", "\u3053\u3093"]);
    expect(array).not.toContain("\\u");
    expect(Buffer.from(array, "utf8").toString("utf8")).toBe(array);
    expect(array).toBe('["\u00e9lodie","\u3053\u3093"]');
    expect(JSON.stringify(["a b", "c"])).toBe('["a b","c"]');
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
