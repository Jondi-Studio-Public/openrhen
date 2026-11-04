import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * Routes a drop-in adds to the proxy (a native push transport). `server.ts` authorises the request first, then
 * asks here before answering 404, so a drop-in never sees an unauthenticated call and shared code names none of
 * them. Registered by `src/drop-ins/<name>/register.ts` when `src/drop-ins.ts` loads it.
 */
export interface ProxyRouteContext {
  request: IncomingMessage;
  response: ServerResponse;
  /** Aborted when the client goes away or an upstream deadline passes; pass its signal to every upstream call. */
  controller: AbortController;
}

export interface ProxyRoute {
  method: "GET" | "POST";
  path: string;
  handle(context: ProxyRouteContext): Promise<unknown>;
}

const routes = new Map<string, ProxyRoute>();
const keyOf = (method: string, path: string) => `${method} ${path}`;

export function registerProxyRoute(route: ProxyRoute): void {
  routes.set(keyOf(route.method, route.path), route);
}

export function findProxyRoute(method: string | undefined, path: string): ProxyRoute | undefined {
  return routes.get(keyOf(method ?? "", path));
}

/** Removes a route (tests). */
export function unregisterProxyRoute(method: string, path: string): void {
  routes.delete(keyOf(method, path));
}
