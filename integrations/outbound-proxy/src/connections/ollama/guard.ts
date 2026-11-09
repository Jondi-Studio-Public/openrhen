/**
 * The address guard for the Ollama connection. It is the inverse of `calendar-feed/guard.ts`: that guard keeps a
 * public URL from reaching private space; this one lets a request reach exactly one kind of private space (the
 * person's own LAN or tailnet) and nothing else, because the proxy sits on the compose network beside `postgres` and
 * `engine-service`, and a typed address must never be a way to talk to them, to the host, or to a cloud metadata
 * service. Only IP literals are accepted, so there is no name lookup and nothing to rebind.
 *
 * The rules, in the order they run:
 *  1. Syntax (`parseOllamaBaseUrl`). The text is matched strictly before any URL parser sees it, so userinfo,
 *     backslashes, queries, fragments, odd IPv4 spellings (decimal, hex, octal, short forms), host names and IPv6
 *     zone ids never get normalised into something allowed. Scheme `http` only and an optional path of `/`. The host
 *     is a strict dotted-quad IPv4 or a bracketed IPv6 literal. The port is 11434 (the default when omitted) or one
 *     the operator added with `OUTBOUND_OLLAMA_EXTRA_PORTS`; a static list of ports the stack and host use is
 *     refused even then. Anything else could be probed through the outcome messages, so only one port is open.
 *  2. Addresses (`classifyAddress`). Only these are allowed: 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT, which is
 *     what a tailnet uses) and fc00::/7 (which covers the tailnet's fd7a:115c:a1e0::/48). Everything else is denied,
 *     including every public address. Inside those ranges two things are still denied: the metadata addresses
 *     (169.254.169.254 is link-local anyway; 100.100.100.200 is Alibaba's and sits in CGNAT; fd00:ec2::/32 is AWS's
 *     IPv6 one) and any address inside a subnet of one of the proxy's own interfaces, read once at start, which is
 *     where `postgres`, `engine-service` and the bridge gateway live. IPv4-mapped IPv6 (`::ffff:a.b.c.d`, in either
 *     spelling) is judged as the IPv4 it carries.
 * Redirects, the response size cap and the fixed paths belong to the caller (`client.ts`).
 */
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { parseIpBytes } from "../../host/ip-address.js";

export const DEFAULT_OLLAMA_PORT = 11434;
export const MIN_OLLAMA_PORT = 1024;
export const EXTRA_PORTS_ENV = "OUTBOUND_OLLAMA_EXTRA_PORTS";
/** Ports of the stack itself and the usual host services (published postgres is 55432, the engine 4100, the proxy 4200, the portal 8787). */
export const DENIED_PORTS: ReadonlySet<number> = new Set([
  1433, 2375, 2376, 3000, 3306, 3389, 4100, 4200, 5432, 5900, 6379, 8787, 9200, 27017, 55432
]);

export type ParsedBaseUrl = { ok: true; host: string; port: number; literal: 4 | 6 };
export type Refusal = { ok: false; reason: RefusalReason; message: string };
export type RefusalReason =
  "bad_url" | "loopback" | "link_local" | "metadata" | "own_network" | "not_private" | "dns_failed";

const refuse = (reason: RefusalReason, message: string): Refusal => ({ ok: false, reason, message });

const HOW =
  "Use the http address of the machine running Ollama on your LAN or tailnet, for example http://192.168.1.20:11434.";

const AUTHORITY = /^http:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/;
const OCTET = /^(0|[1-9]\d{0,2})$/;

/** The ports Ollama may be on: 11434 and the operator's extras. Throws a sentence naming the fix when the variable is malformed (the connection then fails to load, loudly, at start). */
export function ollamaPortsFromEnv(env: Record<string, string | undefined>): ReadonlySet<number> {
  const ports = new Set<number>([DEFAULT_OLLAMA_PORT]);
  const text = env[EXTRA_PORTS_ENV]?.trim();
  if (!text) return ports;
  for (const part of text.split(",")) {
    const port = /^\d{1,5}$/.test(part.trim()) ? Number(part.trim()) : NaN;
    if (!(port >= MIN_OLLAMA_PORT && port <= 65_535) || DENIED_PORTS.has(port))
      throw new Error(
        `${EXTRA_PORTS_ENV} must be a comma list of ports from 1024 to 65535 that the stack does not use (not ${[...DENIED_PORTS].join(", ")}); "${part.trim()}" is not allowed.`
      );
    ports.add(port);
  }
  return ports;
}

export function parseOllamaBaseUrl(
  raw: unknown,
  allowedPorts: ReadonlySet<number> = new Set([DEFAULT_OLLAMA_PORT])
): ParsedBaseUrl | Refusal {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255)
    return refuse("bad_url", `baseUrl must be a short text. ${HOW}`);
  const match = AUTHORITY.exec(raw);
  if (!match)
    return refuse(
      "bad_url",
      `baseUrl must look exactly like http://IP:11434 with no login, path, query or fragment (https is not supported). ${HOW}`
    );
  const authorityHost = match[1] as string;
  const port = match[2] === undefined ? DEFAULT_OLLAMA_PORT : Number(match[2]);
  if (!allowedPorts.has(port) || DENIED_PORTS.has(port))
    return refuse(
      "bad_url",
      `Port ${match[2] ?? port} is not allowed. Ollama's port is ${DEFAULT_OLLAMA_PORT}. To use another port the operator adds it to ${EXTRA_PORTS_ENV} (a comma list of ports from 1024 to 65535) on the outbound proxy and restarts it; ports the stack itself uses (such as 4100, 4200, 5432, 8787, 55432) are never allowed.`
    );

  if (authorityHost.startsWith("[")) {
    const inner = authorityHost.slice(1, -1);
    if (isIP(inner) !== 6) return refuse("bad_url", `The IPv6 address in baseUrl is not valid. ${HOW}`);
    return { ok: true, host: inner.toLowerCase(), port, literal: 6 };
  }
  const parts = authorityHost.split(".");
  if (parts.length === 4 && parts.every((part) => OCTET.test(part) && Number(part) <= 255))
    return { ok: true, host: authorityHost, port, literal: 4 };
  return refuse(
    "bad_url",
    `baseUrl must use the IP address of the machine running Ollama, as four plain decimal numbers (host names, decimal, hex, octal and short forms are refused). ${HOW}`
  );
}

type Net = { bytes: Uint8Array; bits: number };

function inNet(address: Uint8Array, net: Net): boolean {
  if (address.length !== net.bytes.length) return false;
  const whole = Math.floor(net.bits / 8);
  for (let i = 0; i < whole; i++) if (address[i] !== net.bytes[i]) return false;
  const rest = net.bits % 8;
  if (rest === 0) return true;
  const mask = (0xff << (8 - rest)) & 0xff;
  return ((address[whole] ?? 0) & mask) === ((net.bytes[whole] ?? 0) & mask);
}

const net = (text: string, bits: number): Net => ({ bytes: parseIpBytes(text) as Uint8Array, bits });
const ALLOWED: readonly Net[] = [
  net("10.0.0.0", 8),
  net("172.16.0.0", 12),
  net("192.168.0.0", 16),
  net("100.64.0.0", 10),
  net("fc00::", 7)
];
const LOOPBACK: readonly Net[] = [net("127.0.0.0", 8), net("::1", 128)];
const LINK_LOCAL: readonly Net[] = [net("169.254.0.0", 16), net("fe80::", 10)];
const METADATA: readonly Net[] = [net("169.254.169.254", 32), net("100.100.100.200", 32), net("fd00:ec2::", 32)];

/** The subnets of the proxy's own interfaces. `interfaces` takes the `cidr` fields of `os.networkInterfaces()`. */
export function parseOwnNetworks(interfaces: readonly { cidr?: string | null }[]): Net[] {
  const out: Net[] = [];
  for (const entry of interfaces) {
    const match = /^([^/]+)\/(\d{1,3})$/.exec(entry.cidr ?? "");
    const bytes = match ? parseIpBytes(match[1] as string) : null;
    const bits = match ? Number(match[2]) : NaN;
    if (bytes && bits >= 0 && bits <= bytes.length * 8)
      out.push({ bytes: canonical(bytes), bits: bits - (isMapped(bytes) ? 96 : 0) });
  }
  return out;
}

/** Reads the subnets once; call it at start (the connection does, when the host creates it). */
export function readOwnNetworks(): Net[] {
  return parseOwnNetworks(Object.values(networkInterfaces()).flatMap((list) => list ?? []));
}

const isMapped = (bytes: Uint8Array) =>
  bytes.length === 16 && bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 255 && bytes[11] === 255;
const canonical = (bytes: Uint8Array) => (isMapped(bytes) ? bytes.slice(12) : bytes);

/** Null when the address may be used; otherwise why not. */
export function classifyAddress(
  address: string,
  ownNetworks: readonly Net[]
): "loopback" | "link_local" | "metadata" | "own_network" | "not_private" | null {
  const parsed = parseIpBytes(address);
  if (!parsed) return "not_private";
  const bytes = canonical(parsed);
  if (LOOPBACK.some((n) => inNet(bytes, n))) return "loopback";
  if (METADATA.some((n) => inNet(bytes, n))) return "metadata";
  if (LINK_LOCAL.some((n) => inNet(bytes, n))) return "link_local";
  if (ownNetworks.some((n) => inNet(bytes, n))) return "own_network";
  return ALLOWED.some((n) => inNet(bytes, n)) ? null : "not_private";
}

const WHY: Record<Exclude<ReturnType<typeof classifyAddress>, null>, string> = {
  loopback: "this machine itself (loopback), which is the proxy container and not your computer",
  link_local: "a link-local address",
  metadata: "a cloud metadata address",
  own_network: "inside this stack's own network (where the database and the engine live)",
  not_private: "not a private LAN or tailnet address"
};

export type Resolved = {
  ok: true;
  /** The checked address to connect to. */
  address: string;
  family: 4 | 6;
  /** The `Host` header, as typed. */
  hostHeader: string;
  /** `http://<checked address>:<port>`, IPv6 bracketed. */
  origin: string;
};

export interface ResolveDeps {
  ownNetworks: readonly Net[];
}

const originOf = (address: string, family: 4 | 6, port: number) =>
  `http://${family === 6 ? `[${address}]` : address}:${port}`;

function denied(host: string, reason: keyof typeof WHY): Refusal {
  return refuse(
    reason,
    `${host} is ${WHY[reason]}. Only a private LAN or tailnet address of another machine is allowed (10.x.x.x, 172.16-31.x.x, 192.168.x.x, 100.64-127.x.x, or an fc00::/7 address). Use the address of the computer running Ollama.`
  );
}

/** The checked address to call, or why not. The literal is used as typed; there is no lookup. */
export function checkOllamaTarget(parsed: ParsedBaseUrl, deps: ResolveDeps): Resolved | Refusal {
  const hostHeader = parsed.literal === 6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`;
  const reason = classifyAddress(parsed.host, deps.ownNetworks);
  if (reason) return denied(parsed.host, reason);
  return {
    ok: true,
    address: parsed.host,
    family: parsed.literal,
    hostHeader,
    origin: originOf(parsed.host, parsed.literal, parsed.port)
  };
}
