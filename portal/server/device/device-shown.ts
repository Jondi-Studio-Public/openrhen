import { log } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { logOfferShown } from "@/server/persistence/postgres/offer-log-writer";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import type { DeviceActivity } from "./device-now";

/** The offer-log target a handheld snapshot's activity stands for (the wire carries a trimmed title and the session's own id). */
export function deviceShownTarget(activity: DeviceActivity | null) {
  if (!activity) return { resolutionKind: "free", targetType: "none", targetId: "free", label: "" };
  const targetType = {
    session: "session",
    routine_step: "routine_step",
    commitment: "fixed_commitment",
    travel: "travel",
    sleep: "sleep",
    recommended: "action"
  }[activity.kind];
  return { resolutionKind: activity.kind, targetType, targetId: activity.id, label: activity.title };
}

/**
 * Logs a `shown` row with surface `handheld` for a 200 poll whose ETag changed. This is a read path outside any user
 * command, so a failure here is caught, logged and swallowed: the device always gets its snapshot. The caller must not
 * await it on the response path and must never call it for a 304.
 */
export async function logDeviceShown(activity: DeviceActivity | null): Promise<void> {
  try {
    const connectionString = databaseUrl();
    if (!connectionString) return;
    const sql = sqlPool(connectionString);
    const userId = await ensureUser(sql);
    await logOfferShown(sql, userId, { surface: "handheld", ...deviceShownTarget(activity) });
  } catch (error) {
    log("error", "Offer log shown (handheld) failed", {
      route: "/api/device/now",
      method: "GET",
      status: 200,
      durationMs: 0,
      commandType: "offer-shown",
      errorClass: error instanceof Error ? error.constructor.name : typeof error
    });
  }
}
