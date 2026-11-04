import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { CliError, EXIT, NetworkError } from "./errors.js";

export const DEFAULT_PORTAL_URL = "http://localhost:8787";
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface CliConfig {
  /** Origin of the portal, with no trailing path. */
  url: string;
  timeoutMs: number;
  allowPublic: boolean;
  /**
   * Set when the host is a name that is not private by its spelling (a LAN name under a public domain,
   * such as the portal's HTTPS name behind Caddy). The client resolves it before its first request and
   * refuses unless every address is private; see `assertPrivateAddresses`.
   */
  checkAddresses?: boolean;
  /** Set only when no flag, `OPENRHEN_URL` or config-file url was given, so the client can say how to point elsewhere. */
  fromDefault?: true;
}

export interface ConfigInputs {
  url?: string | undefined;
  timeout?: string | undefined;
  allowPublic?: boolean | undefined;
}

export interface ConfigSources {
  env: NodeJS.ProcessEnv;
  /** `~/.openrhen/config.json`, or null when absent or unreadable. */
  readConfigFile: () => Record<string, unknown> | null;
}

export function defaultConfigSources(): ConfigSources {
  return {
    env: process.env,
    readConfigFile: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(homedir(), ".openrhen", "config.json"), "utf8"));
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
      } catch {
        return null;
      }
    }
  };
}

/**
 * Flag, then environment, then config file, then `DEFAULT_PORTAL_URL` (`http://localhost:8787`). The portal is
 * single-tenant and unauthenticated, so a public host is refused unless `--allow-public` says the
 * caller knows that: a typo must not send the household's planning data across the internet.
 */
export function resolveConfig(inputs: ConfigInputs, sources: ConfigSources = defaultConfigSources()): CliConfig {
  const file = sources.readConfigFile();
  const fileUrl = typeof file?.url === "string" ? file.url : undefined;
  const fileTimeout = typeof file?.timeoutMs === "number" ? String(file.timeoutMs) : undefined;
  const given = inputs.url ?? sources.env.OPENRHEN_URL ?? fileUrl;
  const url = given ?? DEFAULT_PORTAL_URL;
  const fromDefault = given === undefined ? ({ fromDefault: true } as const) : {};
  const timeoutRaw = inputs.timeout ?? sources.env.OPENRHEN_TIMEOUT_MS ?? fileTimeout;
  const timeoutMs = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new CliError(`Invalid timeout: ${timeoutRaw}`, EXIT.usage);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`Invalid portal URL: ${url}`, EXIT.usage);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new CliError(`Portal URL must be http or https: ${url}`, EXIT.usage);

  const allowPublic = inputs.allowPublic ?? sources.env.OPENRHEN_ALLOW_PUBLIC === "1";
  if (allowPublic || isPrivateHost(parsed.hostname))
    return { url: parsed.origin, timeoutMs, allowPublic, ...fromDefault };
  // A public address literal can only be public; a name may still resolve to the LAN.
  if (isIP(bareHost(parsed.hostname)) !== 0 || parsed.protocol !== "https:")
    throw new CliError(
      `Refusing to talk to ${parsed.hostname}: it is not a LAN, loopback, or private-network (VPN) address. ` +
        "The portal is unauthenticated, so pass --allow-public only if you mean it.",
      EXIT.usage
    );
  return { url: parsed.origin, timeoutMs, allowPublic, checkAddresses: true };
}

export type AddressLookup = (hostname: string) => Promise<readonly { address: string }[]>;

const systemLookup: AddressLookup = (hostname) => lookup(hostname, { all: true });

/**
 * The network check behind `checkAddresses`: an HTTPS name is accepted when every address it resolves
 * to is private, so `https://openrhen.example.com` (answered by the LAN's DNS) works without
 * `--allow-public` while a typo that resolves to the internet is still refused. It is a typo guard, not
 * a DNS-rebinding defence: `fetch` resolves the name again, so a hostile name's DNS could answer
 * differently. The URL comes only from the user's own flag, environment or config file.
 */
export async function assertPrivateAddresses(
  hostname: string,
  lookupImpl: AddressLookup = systemLookup
): Promise<void> {
  let addresses: readonly { address: string }[];
  try {
    addresses = await lookupImpl(hostname);
  } catch (error) {
    // A NetworkError, like a failed fetch, so a keyed write retries a resolver hiccup.
    throw new NetworkError(`Cannot resolve ${hostname}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const publicAddress = addresses.find(({ address }) => !isPrivateHost(address));
  if (addresses.length === 0 || publicAddress)
    throw new CliError(
      `Refusing to talk to ${hostname}: it resolves to ${publicAddress?.address ?? "no address"}, which is not a LAN, ` +
        "loopback, or private-network (VPN) address. The portal is unauthenticated, so pass --allow-public only if you mean it.",
      EXIT.usage
    );
}

function bareHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "");
}

/** Loopback, RFC 1918, link-local, Tailscale's CGNAT range, and the usual LAN name suffixes. */
export function isPrivateHost(hostname: string): boolean {
  const host = bareHost(hostname).toLowerCase();
  if (host === "localhost") return true;
  const family = isIP(host);
  if (family === 4) return isPrivateIpv4(host);
  if (family === 6) return isPrivateIpv6(host);
  for (const suffix of [".localhost", ".local", ".lan", ".internal", ".home.arpa", ".ts.net"])
    if (host.endsWith(suffix)) return true;
  // A single-label name resolves only on the local network.
  return !host.includes(".");
}

function isPrivateIpv4(host: string): boolean {
  const [a, b] = host.split(".").map(Number) as [number, number];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/** Loopback, unique local `fc00::/7`, link-local `fe80::/10`, and IPv4-mapped private addresses. */
function isPrivateIpv6(host: string): boolean {
  if (host === "::1") return true;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  // The URL parser writes a mapped address in hex: a dotted mapped address such as [::ffff:10.0.0.1] becomes [::ffff:a00:1].
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const [high, low] = [parseInt(mappedHex[1]!, 16), parseInt(mappedHex[2]!, 16)];
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  const first = parseInt(host.split(":", 1)[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
}
