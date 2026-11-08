/**
 * The address guard for the Ollama connection. It is the inverse of `calendar-feed/guard.ts`: that guard keeps a
 * public URL from reaching private space; this one lets a request reach exactly one kind of private space (the
 * person's own LAN or tailnet) and nothing else, because the proxy sits on the compose network beside `postgres` and
 * `engine-service`, and a typed address must never be a way to talk to them, to the host, or to a cloud metadata
 * service.
 *
 * The rules, in the order they run:
 *  1. Syntax (`parseOllamaBaseUrl`). The text is matched strictly before any URL parser sees it, so userinfo,
 *     backslashes, queries, fragments, odd IPv4 spellings (decimal, hex, octal, short forms) and IPv6 zone ids never
 *     get normalised into something allowed. Scheme `http` only, an optional path of `/`, an optional port (default
 *     11434) from 1024 up and not one the stack itself uses. The host is a strict dotted-quad IPv4, a bracketed
 *     IPv6 literal, or a DNS name that has a dot, whose last label starts with a letter and which is not under
 *     `.localhost`, `.internal` or `.docker`. A name with no dot is refused outright: Docker's DNS answers every
 *     compose service name (`postgres`, `engine-service`, `outbound-proxy`) and nothing else uses single labels.
 *  2. Addresses (`classifyAddress`). Only these are allowed: 10/8, 172.16/12, 192.168/16, 100.64/10 (CGNAT, which is
 *     what a tailnet uses) and fc00::/7 (which covers the tailnet's fd7a:115c:a1e0::/48). Everything else is denied,
 *     including every public address. Inside those ranges two things are still denied: the metadata addresses
 *     (169.254.169.254 is link-local anyway; 100.100.100.200 is Alibaba's and sits in CGNAT; fd00:ec2::/32 is AWS's
 *     IPv6 one) and any address inside a subnet of one of the proxy's own interfaces, read once at start, which is
 *     where `postgres`, `engine-service` and the bridge gateway (the host's published ports) live. IPv4-mapped IPv6
 *     (`::ffff:a.b.c.d`, in either spelling) is judged as the IPv4 it carries.
 *  3. Resolution (`resolveOllamaTarget`). A literal is used as typed. A name is looked up exactly once; every
 *     answer must pass rule 2 (one bad answer refuses the lot); IPv4 is preferred; the connection then goes to that
 *     checked address (the caller builds the URL from `origin`), never to the name again, so a second answer from a
 *     rebinding DNS server is never seen. The `Host` header stays as typed.
 * Redirects, the response size cap and the fixed paths belong to the caller (`client.ts`).
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { parseIpBytes } from "../../host/ip-address.js";

export const DEFAULT_OLLAMA_PORT = 11434;
export const MIN_OLLAMA_PORT = 1024;
/** Ports of the stack itself and the usual host services (published postgres is 55432, the engine 4100, the proxy 4200, the portal 8787). */
export const DENIED_PORTS: ReadonlySet<number> = new Set([
  1433, 2375, 2376, 3000, 3306, 3389, 4100, 4200, 5432, 5900, 6379, 8787, 9200, 27017, 55432
]);

export type ParsedBaseUrl = { ok: true; host: string; port: number; literal: 4 | 6 | null };
export type Refusal = { ok: false; reason: RefusalReason; message: string };
export type RefusalReason =
  "bad_url" | "loopback" | "link_local" | "metadata" | "own_network" | "not_private" | "dns_failed";

const refuse = (reason: RefusalReason, message: string): Refusal => ({ ok: false, reason, message });

const HOW =
  "Use the http address of the machine running Ollama on your LAN or tailnet, for example http://192.168.1.20:11434.";

const AUTHORITY = /^http:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/;
const OCTET = /^(0|[1-9]\d{0,2})$/;
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DENIED_SUFFIXES = [".localhost", ".internal", ".docker"];

export function parseOllamaBaseUrl(raw: unknown): ParsedBaseUrl | Refusal {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 255)
    return refuse("bad_url", `baseUrl must be a short text. ${HOW}`);
  const match = AUTHORITY.exec(raw);
  if (!match)
    return refuse(
      "bad_url",
      `baseUrl must look exactly like http://host:port with no login, path, query or fragment (https is not supported). ${HOW}`
    );
  const authorityHost = match[1] as string;
  const port = match[2] === undefined ? DEFAULT_OLLAMA_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < MIN_OLLAMA_PORT || port > 65_535 || DENIED_PORTS.has(port))
    return refuse(
      "bad_url",
      `Port ${match[2] ?? port} is not allowed: use 1024 to 65535, and not a port this stack or the host uses (such as 4100, 4200, 5432, 8787, 55432). Ollama's own port is ${DEFAULT_OLLAMA_PORT}.`
    );

  if (authorityHost.startsWith("[")) {
    const inner = authorityHost.slice(1, -1);
    if (isIP(inner) !== 6) return refuse("bad_url", `The IPv6 address in baseUrl is not valid. ${HOW}`);
    return { ok: true, host: inner.toLowerCase(), port, literal: 6 };
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(authorityHost)) {
    const parts = authorityHost.split(".");
    if (!parts.every((part) => OCTET.test(part) && Number(part) <= 255))
      return refuse("bad_url", `The IPv4 address in baseUrl must be four plain decimal numbers from 0 to 255. ${HOW}`);
    return { ok: true, host: authorityHost, port, literal: 4 };
  }
  const host = authorityHost.toLowerCase();
  const labels = host.split(".");
  if (labels.length < 2)
    return refuse(
      "bad_url",
      `A name with no dot is refused because it would be looked up as a container on this stack (postgres, engine-service and so on). Use the IP address of the machine running Ollama, or its full tailnet name. ${HOW}`
    );
  if (
    host.length > 253 ||
    labels.some((label) => label.length > 63 || !LABEL.test(label)) ||
    !/^[a-z]/.test(labels[labels.length - 1] as string)
  )
    return refuse(
      "bad_url",
      `That host name is not valid (the last part must start with a letter; numbers that are not four plain decimal parts, hex and octal spellings are refused). ${HOW}`
    );
  if (DENIED_SUFFIXES.some((suffix) => host.endsWith(suffix)))
    return refuse("bad_url", `Names ending in .localhost, .internal or .docker are not allowed. ${HOW}`);
  return { ok: true, host, port, literal: null };
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
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
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

export async function resolveOllamaTarget(parsed: ParsedBaseUrl, deps: ResolveDeps): Promise<Resolved | Refusal> {
  const hostHeader = parsed.literal === 6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`;
  if (parsed.literal) {
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
  let answers: { address: string; family: number }[];
  try {
    answers = await (deps.lookup ?? ((name) => dnsLookup(name, { all: true, verbatim: true })))(parsed.host);
  } catch {
    answers = [];
  }
  if (answers.length === 0)
    return refuse(
      "dns_failed",
      `${parsed.host} did not resolve from inside the proxy (a tailnet MagicDNS name often does not). Use the machine's IP address instead, for example http://100.101.5.5:${parsed.port}.`
    );
  for (const { address } of answers) {
    const reason = classifyAddress(address, deps.ownNetworks);
    if (reason) return denied(parsed.host, reason);
  }
  const chosen = answers.find((a) => a.family === 4) ?? (answers[0] as { address: string; family: number });
  const family = chosen.family === 4 ? 4 : 6;
  return {
    ok: true,
    address: chosen.address,
    family,
    hostHeader,
    origin: originOf(chosen.address, family, parsed.port)
  };
}
