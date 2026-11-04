import { lookup as dnsLookup } from "node:dns/promises";
import tls from "node:tls";
import { FEED_CONNECT_MS, FEED_TOTAL_MS, FeedFetchError, normalizeFeedUrl, ordered } from "./fetch.js";
import { isDeniedAddress } from "./guard.js";

export type FeedProofOptions = {
  signal?: AbortSignal;
  /** Test seams. Production uses dns and tls. */
  lookup?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  connect?: typeof tls.connect;
  isDenied?: (address: string) => boolean;
  totalMs?: number;
  connectMs?: number;
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

function handshake(
  connect: typeof tls.connect,
  host: string,
  address: string,
  budgetMs: number,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: address, port: 443, servername: host, rejectUnauthorized: true });
    const done = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      // No request is ever written: the handshake is the whole proof, so nothing is downloaded.
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => done(Object.assign(new Error("aborted"), { code: "ABORTED" }));
    const timer = setTimeout(
      () => done(Object.assign(new Error("connect timeout"), { code: "CONNECT_TIMEOUT" })),
      budgetMs
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    socket.once("secureConnect", () => done());
    socket.once("error", (error) => done(error));
  });
}

/**
 * The feed's passive proof (design v4 (a)): the URL is valid, every DNS answer clears the deny check and a TLS handshake
 * completes against the hostname. It sends no request and downloads nothing. Resolves to the host; throws a
 * `FeedFetchError` carrying the host only, never the URL.
 */
export async function proveCalendarFeed(rawUrl: string, options: FeedProofOptions = {}): Promise<{ host: string }> {
  const lookup = options.lookup ?? ((h: string) => dnsLookup(h, { all: true, verbatim: true }));
  const connect = options.connect ?? tls.connect;
  const isDenied = options.isDenied ?? isDeniedAddress;
  const controller = new AbortController();
  const totalTimer = setTimeout(
    () => controller.abort(new FeedFetchError("timeout")),
    options.totalMs ?? FEED_TOTAL_MS
  );
  const onAbort = () => controller.abort(new FeedFetchError("aborted"));
  if (options.signal?.aborted) onAbort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const aborted = () =>
    controller.signal.reason instanceof FeedFetchError ? controller.signal.reason : new FeedFetchError("aborted");
  try {
    const url = normalizeFeedUrl(rawUrl);
    const host = url.hostname;
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

    // Same order and rule as the read: IPv4 first, moving on only after a connect-level failure; a TLS error is final.
    const connectDeadline = Date.now() + (options.connectMs ?? FEED_CONNECT_MS);
    let lastError: unknown;
    for (const { address } of ordered(answers)) {
      const remaining = connectDeadline - Date.now();
      if (remaining <= 0) break;
      try {
        await handshake(connect, host, address, remaining, controller.signal);
        return { host };
      } catch (error) {
        lastError = error;
        if (controller.signal.aborted) throw aborted();
        if (!CONNECT_ERRORS.has((error as { code?: string }).code ?? "")) throw new FeedFetchError("network", host);
      }
    }
    throw new FeedFetchError(lastError ? "connect_failed" : "timeout", host);
  } finally {
    clearTimeout(totalTimer);
    controller.abort();
    options.signal?.removeEventListener("abort", onAbort);
  }
}
