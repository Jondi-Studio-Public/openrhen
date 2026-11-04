/**
 * Counts an agent's requests into sessions for agent time. Called by `withRoute`
 * once a request has an agent identity and has passed auth; it never delays or fails the request it describes.
 */

/** Routes that say nothing about an agent working: probes, the CLI's version check, and agent time itself. */
const UNCOUNTED = [/^\/api\/health(\/|$)/, /^\/api\/cli(\/|$)/, /^\/api\/agent-sessions$/];

export const countsAsAgentWork = (route: string): boolean => !UNCOUNTED.some((pattern) => pattern.test(route));

// One write at a time per agent, so two quick calls cannot each open a session.
const chains = new Map<string, Promise<void>>();

/** Resolves once this call is recorded (or dropped); the request never waits for it, only tests do. */
export function noteAgentCall(agent: string, route: string, method: string): Promise<void> {
  if (!countsAsAgentWork(route)) return Promise.resolve();
  const write = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const previous = chains.get(agent) ?? Promise.resolve();
  const next = previous.then(async () => {
    try {
      const [{ databaseUrl }, { sqlPool }, { recordAgentCall }] = await Promise.all([
        import("./runtime-env"),
        import("./persistence/postgres/sql-pool"),
        import("./agent-session-store")
      ]);
      const url = databaseUrl();
      if (url) await recordAgentCall(sqlPool(url), { agent, route, write });
    } catch {
      // Missing table mid-migration, database down: a missed count must never fail the request it describes.
    }
  });
  chains.set(agent, next);
  void next.then(() => {
    if (chains.get(agent) === next) chains.delete(agent);
  });
  return next;
}
