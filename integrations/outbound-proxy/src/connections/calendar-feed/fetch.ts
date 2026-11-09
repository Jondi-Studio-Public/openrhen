import { lookup as dnsLookup } from "node:dns/promises";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { decodeBody, FeedDecodeError, toUtf8Bytes } from "./decode.js";
import { isDeniedAddress } from "./guard.js";

export const FEED_MAX_BYTES = 5 * 1024 * 1024;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_TOTAL_MS = 12_000;
export const FEED_CONNECT_MS = 5_000;

export type FeedFetchCode =
  | "bad_url"
  | "denied_address"
  | "dns_failed"
  | "connect_failed"
  | "timeout"
  | "aborted"
  | "bad_redirect"
  | "too_many_redirects"
  | "http_status"
  | "too_large"
  | "decode_failed"
  | "unsupported_encoding"
  | "network";

/** Carries the host only. The URL (path and query) is a secret and never enters a message. */
export class FeedFetchError extends Error {
  constructor(
    readonly code: FeedFetchCode,
    readonly host?: string,
    readonly status?: number
  ) {
    super(`calendar feed ${code}${host ? ` (${host})` : ""}${status ? ` status ${status}` : ""}`);
    this.name = "FeedFetchError";
  }
}

export type FeedFetchResult = {
  /** Calendar text as BOM-free UTF-8 bytes, content-coding and charset already undone. At most FEED_MAX_BYTES before transcoding. */
  bytes: Buffer;
  host: string;
  status: 200;
};

export type FeedFetchOptions = {
  signal?: AbortSignal;
  /** Test seams. Production uses dns and https. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  request?: typeof https.request;
  isDenied?: (address: string) => boolean;
  totalMs?: number;
  connectMs?: number;
  maxBytes?: number;
};

const CONNECT_ERRORS = new Set([
  "ECONNREFUSED",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "EACCES",
  "EPERM",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "CONNECT_TIMEOUT"
]);

/** webcal(s) maps to https; http, userinfo, IP literals and non-443 ports are refused. */
export function normalizeFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim().replace(/^webcals?:/i, "https:"));
  } catch {
    throw new FeedFetchError("bad_url");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "443") ||
    !host ||
    isIP(host)
  ) {
    throw new FeedFetchError("bad_url", isIP(host) ? undefined : host || undefined);
  }
  return url;
}

/** IPv4 first, then the rest, each in answer order. */
export function ordered(addresses: { address: string; family: number }[]) {
  return [...addresses.filter((a) => a.family === 4), ...addresses.filter((a) => a.family !== 4)];
}

type Hop = { response: IncomingMessage; host: string };

function attempt(
  url: URL,
  address: string,
  family: number,
  o: Required<Pick<FeedFetchOptions, "request">>,
  connectMs: number,
  signal: AbortSignal
): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const host = url.hostname;
    const req = o.request({
      host: address,
      family,
      port: 443,
      servername: host,
      method: "GET",
      path: `${url.pathname}${url.search}`,
      // A private agent: never the global one, so HTTP(S)_PROXY / NODE_USE_ENV_PROXY cannot reroute this.
      agent: new https.Agent({ keepAlive: false }),
      headers: {
        host: url.host,
        accept: "text/calendar, text/plain;q=0.8, */*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
        "user-agent": "OpenRhen-calendar-feed/1"
      },
      signal
    });
    let timer: NodeJS.Timeout | undefined;
    req.once("socket", (socket) => {
      if (!socket.connecting) return;
      timer = setTimeout(
        () => req.destroy(Object.assign(new Error("connect timeout"), { code: "CONNECT_TIMEOUT" })),
        connectMs
      );
      socket.once("connect", () => clearTimeout(timer));
    });
    req.once("response", (response) => {
      clearTimeout(timer);
      resolve({ response, host });
    });
    req.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end();
  });
}

async function readCapped(response: IncomingMessage, max: number, host: string): Promise<Buffer> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max && !response.headers["content-encoding"])
    throw new FeedFetchError("too_large", host);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > max) {
      response.destroy();
      throw new FeedFetchError("too_large", host);
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function fetchCalendarFeed(rawUrl: string, options: FeedFetchOptions = {}): Promise<FeedFetchResult> {
  const lookup = options.lookup ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
  const request = options.request ?? https.request;
  const isDenied = options.isDenied ?? isDeniedAddress;
  const maxBytes = options.maxBytes ?? FEED_MAX_BYTES;
  const controller = new AbortController();
  const deadline = Date.now() + (options.totalMs ?? FEED_TOTAL_MS);
  const totalTimer = setTimeout(
    () => controller.abort(new FeedFetchError("timeout")),
    Math.max(0, deadline - Date.now())
  );
  const onAbort = () => controller.abort(new FeedFetchError("aborted"));
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const aborted = () =>
    controller.signal.reason instanceof FeedFetchError ? controller.signal.reason : new FeedFetchError("aborted");
  try {
    let url = normalizeFeedUrl(rawUrl);
    for (let hops = 0; ; hops++) {
      const host = url.hostname;
      if (controller.signal.aborted) throw aborted();
      let answers: { address: string; family: number }[];
      try {
        answers = await Promise.race([
          lookup(host),
          new Promise<never>((_, reject) =>
            controller.signal.addEventListener("abort", () => reject(aborted()), { once: true })
          )
        ]);
      } catch (error) {
        throw error instanceof FeedFetchError ? error : new FeedFetchError("dns_failed", host);
      }
      if (answers.length === 0) throw new FeedFetchError("dns_failed", host);
      if (answers.some((a) => isDenied(a.address))) throw new FeedFetchError("denied_address", host);

      // Connect-level failures move to the next checked address; TLS and HTTP errors do not.
      const connectDeadline = Date.now() + (options.connectMs ?? FEED_CONNECT_MS);
      let hop: Hop | undefined;
      let lastError: unknown;
      for (const { address, family } of ordered(answers)) {
        const remaining = connectDeadline - Date.now();
        if (remaining <= 0) break;
        try {
          hop = await attempt(url, address, family, { request }, remaining, controller.signal);
          break;
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted) throw aborted();
          if (!CONNECT_ERRORS.has((error as { code?: string }).code ?? "")) throw new FeedFetchError("network", host);
          // attempt() got only the remaining budget, so its timer firing means the budget is spent. Do not
          // re-derive that from Date.now(): the timer runs off the loop clock and can fire before it agrees.
          if ((error as { code?: string }).code === "CONNECT_TIMEOUT") break;
        }
      }
      if (!hop) throw new FeedFetchError(lastError ? "connect_failed" : "timeout", host);

      const { response } = hop;
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.destroy();
        const location = response.headers.location;
        if (hops >= FEED_MAX_REDIRECTS) throw new FeedFetchError("too_many_redirects", host);
        if (!location) throw new FeedFetchError("bad_redirect", host);
        try {
          url = normalizeFeedUrl(new URL(location, url).href);
        } catch {
          throw new FeedFetchError("bad_redirect", host);
        }
        continue;
      }
      if (status !== 200) {
        response.destroy();
        throw new FeedFetchError("http_status", host, status);
      }
      try {
        const raw = await readCapped(response, maxBytes, host);
        const encoding = response.headers["content-encoding"];
        const decoded = await decodeBody(raw, Array.isArray(encoding) ? encoding.join(",") : encoding, maxBytes);
        const type = response.headers["content-type"];
        const bytes = toUtf8Bytes(decoded, Array.isArray(type) ? type[0] : type);
        return { bytes, host, status: 200 };
      } catch (error) {
        if (error instanceof FeedFetchError) throw error;
        if (controller.signal.aborted) throw aborted();
        if (error instanceof FeedDecodeError) throw new FeedFetchError(error.code, host);
        throw new FeedFetchError("network", host);
      }
    }
  } finally {
    clearTimeout(totalTimer);
    // Tears down anything still in flight (an unread response body, say).
    controller.abort();
    options.signal?.removeEventListener("abort", onAbort);
  }
}
