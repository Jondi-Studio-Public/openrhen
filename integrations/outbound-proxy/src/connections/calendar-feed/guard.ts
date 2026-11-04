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

type Cidr = readonly [string, number];

const DENIED_V4: readonly Cidr[] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
];

// ::ffff:0:0/96 and 64:ff9b::/96 are handled separately: the embedded IPv4 is tested instead.
const DENIED_V6: readonly Cidr[] = [
  ["::", 96],
  ["::1", 128],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8]
];

function matches(bytes: Uint8Array, [base, bits]: Cidr): boolean {
  const net = parseIpBytes(base);
  if (!net || net.length !== bytes.length) return false;
  const whole = Math.floor(bits / 8);
  for (let i = 0; i < whole; i++) if (bytes[i] !== net[i]) return false;
  const rem = bits % 8;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((bytes[whole] ?? 0) & mask) === ((net[whole] ?? 0) & mask);
}

/** True when the address must never be fetched (private, loopback, link-local, reserved, or unparseable). */
export function isDeniedAddress(address: string): boolean {
  const bytes = parseIpBytes(address);
  if (!bytes) return true;
  if (bytes.length === 4) return DENIED_V4.some((c) => matches(bytes, c));
  const embedded = (offset: number) => bytes.slice(offset, offset + 4);
  const isPrefix = (prefix: number[]) => prefix.every((b, i) => bytes[i] === b);
  if (isPrefix([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255])) return isDeniedAddress([...embedded(12)].join("."));
  if (isPrefix([0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 0, 0])) return isDeniedAddress([...embedded(12)].join("."));
  if (isPrefix([0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0])) return isDeniedAddress([...embedded(12)].join("."));
  return DENIED_V6.some((c) => matches(bytes, c));
}
