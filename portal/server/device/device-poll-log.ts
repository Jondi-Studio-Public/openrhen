import { recordRunThrottled } from "@/server/persistence/postgres/run-log";
import { deviceTokenHash } from "@/server/owner-auth";

/**
 * What one handheld poll came to: let in (and by what), or turned away (and why). A handheld that is polling but
 * refused, say after a token change, is otherwise a device that has simply gone quiet.
 */
export type DevicePollOutcome =
  { status: "synced"; auth: "device" | "anonymous" } | { status: "failed"; reason: string };

/**
 * Leaves a `device:handheld` run row for a poll, at most one per hour per status (the run log throttles it). An
 * anonymous poll counts as the handheld being seen only while no device token is configured: once one is, an
 * anonymous caller is not the handheld. Never throws, and is meant to run off the response path.
 */
export async function recordDevicePoll(outcome: DevicePollOutcome): Promise<void> {
  try {
    if (outcome.status === "synced" && outcome.auth === "anonymous" && deviceTokenHash() !== undefined) return;
    const now = new Date();
    await recordRunThrottled({
      provider: "device:handheld",
      trigger: "scheduled",
      status: outcome.status,
      startedAt: now,
      finishedAt: now,
      summary: outcome.status === "synced" ? { auth: outcome.auth } : { reason: outcome.reason }
    });
  } catch {
    // The run log is best-effort by design; a poll must never be held up by it.
  }
}
