import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Google's "active" reachability check, since `travel-time-model.md`'s "One spender" ("The
 * Connections check stops spending"): the check itself no longer calls Google. Every real travel
 * lookup now goes through `spendTravelLookup`, which is metered against the daily budget, so a
 * reachability check spending one of those elements purely to answer "is Google up" is exactly the
 * unmetered spend path that plan closed off. This reports the most recent real `travel_matrix` call
 * already recorded by that spender (via `fetchTravelMatrix`'s own `recordProviderCall`) instead.
 *
 * `status: "skipped"` means no `travel_matrix` call has ever been recorded — nothing to report, not
 * a failure — so `getProviderStatus` shows "unknown" rather than "down".
 */

const TRAVEL_MATRIX_OPERATION = "travel_matrix";

export type GoogleReachabilityResult =
  { status: "checked"; ok: boolean; detail?: string | null } | { status: "skipped"; detail: string };

export async function checkGoogleReachability(): Promise<GoogleReachabilityResult> {
  const url = databaseUrl();
  if (!url) return { status: "skipped", detail: "The database is not configured, so telemetry cannot be read." };
  const sql = sqlPool(url);
  const rows = await sql<{ started_at: Date; ok: boolean; error_summary: string | null }[]>`
    SELECT started_at, ok, error_summary FROM provider_call_telemetry
    WHERE provider = 'google' AND operation = ${TRAVEL_MATRIX_OPERATION} AND kind = 'real_call'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const last = rows[0];
  if (!last) return { status: "skipped", detail: "No travel lookup has been made yet." };
  return {
    status: "checked",
    ok: last.ok,
    detail: last.ok ? null : (last.error_summary ?? "The last travel lookup failed.")
  };
}
