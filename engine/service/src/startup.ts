/** The value compose.yaml fills in for a token nobody set. */
export const PLACEHOLDER_TOKEN = "replace-before-lan-use";

/**
 * Why the service must not start, or undefined. A missing token always refuses. The compose placeholder refuses
 * only when `OPENRHEN_OWNER_AUTH=require`, so owner auth cannot be turned on over a token everyone can read in
 * the repo; any other mode behaves as before.
 */
export function startupRefusal(env: Record<string, string | undefined>): string | undefined {
  const token = env.PLAN_FORECAST_SERVICE_TOKEN ?? "";
  if (!token) return "PLAN_FORECAST_SERVICE_TOKEN is required";
  if (token.trim() === PLACEHOLDER_TOKEN && env.OPENRHEN_OWNER_AUTH?.trim().toLowerCase() === "require")
    return "PLAN_FORECAST_SERVICE_TOKEN is still the compose placeholder and OPENRHEN_OWNER_AUTH=require; set a real secret";
  return undefined;
}
