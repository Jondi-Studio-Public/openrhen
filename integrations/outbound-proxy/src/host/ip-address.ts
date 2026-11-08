import { isIP } from "node:net";

/** Parse an IPv4 or IPv6 literal into bytes (4 or 16), or null. IPv4-mapped forms stay 16 bytes. */
export function parseIpBytes(address: string): Uint8Array | null {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const zoneless = bare.split("%")[0] ?? "";
  const family = isIP(zoneless);
  if (family === 4) return Uint8Array.from(zoneless.split(".").map(Number));
  if (family !== 6) return null;
  let text = zoneless;
  let tail: number[] = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4?.[1]) {
    const o = v4[1].split(".").map(Number);
    tail = [((o[0] ?? 0) << 8) | (o[1] ?? 0), ((o[2] ?? 0) << 8) | (o[3] ?? 0)];
    text = text.slice(0, -v4[1].length) + "0:0";
  }
  const [head = "", rest] = text.split("::");
  const headParts = head === "" ? [] : head.split(":");
  const restParts = rest === undefined || rest === "" ? [] : rest.split(":");
  const missing = 8 - headParts.length - restParts.length;
  const groups = rest === undefined ? headParts : [...headParts, ...Array<string>(missing).fill("0"), ...restParts];
  const words = groups.map((g) => Number.parseInt(g, 16));
  if (tail.length === 2) words.splice(6, 2, tail[0] ?? 0, tail[1] ?? 0);
  if (words.length !== 8 || words.some((w) => Number.isNaN(w))) return null;
  return Uint8Array.from(words.flatMap((w) => [w >> 8, w & 255]));
}
