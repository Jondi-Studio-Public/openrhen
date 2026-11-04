/** The header the portal reads the worker token from (`WORKER_HEADER` in platform/contracts). */
export const WORKER_HEADER = "X-OpenRhen-Worker";

/**
 * Headers for a call to a portal route only the worker calls. Adds the worker token when
 * `OPENRHEN_WORKER_TOKEN` is set, so `OPENRHEN_OWNER_AUTH=require` accepts the call; with none set the call
 * is as it was (and `off` and `shadow` need nothing).
 */
export function portalHeaders(
  extra: Record<string, string> = {},
  env: Record<string, string | undefined> = process.env
): Record<string, string> {
  const token = env.OPENRHEN_WORKER_TOKEN?.trim();
  return token ? { ...extra, [WORKER_HEADER]: token } : { ...extra };
}
