import http from "node:http";
import { MAX_RESPONSE_BYTES } from "../../host/model-complete.js";

/** Thrown when the reply is bigger than the cap; the rest is never read. */
export class ResponseTooLarge extends Error {
  constructor() {
    super("response too large");
    this.name = "ResponseTooLarge";
  }
}

/** Thrown when the server answers a status line that is not a valid HTTP status (outside 200 to 599). */
export class InvalidUpstreamStatus extends Error {
  constructor(readonly status: number) {
    super("invalid upstream status");
    this.name = "InvalidUpstreamStatus";
  }
}

/**
 * A `fetch` for one checked address. The URL's host is the already-checked IP (the guard resolved the name once), so
 * nothing here looks a name up; the caller's `host` header is sent as given. It uses a private agent so no
 * HTTP(S)_PROXY setting can reroute it, never follows a redirect (a 3xx comes back as it is), and stops reading at
 * `maxBytes`.
 */
export function pinnedHttpFetch(maxBytes = MAX_RESPONSE_BYTES): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === "string" ? init.body : undefined;
      const request = http.request(
        {
          host: url.hostname.replace(/^\[|\]$/g, ""),
          port: Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init?.method ?? "GET",
          headers: body === undefined ? headers : { ...headers, "content-length": String(Buffer.byteLength(body)) },
          agent: new http.Agent({ keepAlive: false }),
          ...(init?.signal ? { signal: init.signal } : {})
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              response.destroy();
              reject(new ResponseTooLarge());
              return;
            }
            chunks.push(chunk);
          });
          response.once("error", reject);
          response.once("end", () => {
            const status = response.statusCode ?? 0;
            try {
              const outHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers))
                if (typeof value === "string") outHeaders.set(name, value);
              const empty = [204, 205, 304].includes(status);
              resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: outHeaders }));
            } catch {
              // `new Response` throws a RangeError for a status outside 200-599; thrown here it would be uncaught.
              reject(new InvalidUpstreamStatus(status));
            }
          });
        }
      );
      request.once("error", reject);
      request.end(body);
    })) as typeof fetch;
}
