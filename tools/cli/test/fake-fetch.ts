export interface FakeResponse {
  status?: number;
  body: unknown;
}

export interface RecordedCall {
  method: string;
  path: string;
  /** Full request URL, query string included. */
  url: string;
  /** Request headers, names lower-cased. */
  headers: Record<string, string>;
  body: unknown;
}

type Route = FakeResponse | ((call: RecordedCall) => FakeResponse);

/**
 * A `fetch` that answers from a table keyed by pathname and records every call, so a test can
 * assert both what a command printed and that a read-only command never sent a POST.
 */
export function fakeFetch(routes: Record<string, Route>, calls: RecordedCall[] = []): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const call: RecordedCall = {
      method: (init?.method ?? "GET").toUpperCase(),
      path: url.pathname,
      url: url.toString(),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null
    };
    calls.push(call);
    const route = routes[url.pathname];
    const answer: FakeResponse =
      route === undefined
        ? { status: 404, body: { error: "Not found" } }
        : typeof route === "function"
          ? route(call)
          : route;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" }
    });
  };
}

/** A fetch that fails the way a down host does. */
export function unreachableFetch(): typeof fetch {
  return async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  };
}
