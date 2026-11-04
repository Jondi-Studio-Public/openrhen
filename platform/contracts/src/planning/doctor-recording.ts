/**
 * The recorded-elsewhere family of the data health check (the design notes,
 * `plans/data-health-recording-plan.md`): the nightly backup and the phone's location ping. Both leave a
 * timestamp the portal can read; this module judges them. Status only: no paths, hosts or coordinates.
 */
import type { DoctorItem } from "./doctor.js";

const HOUR_MS = 3_600_000;
/** A backup run is nightly; no success for this long means a night was missed. */
export const DOCTOR_BACKUP_STALE_HOURS = 36;
/** A phone that has pinged before and has been silent this long has probably lost its automation. */
export const DOCTOR_PING_SILENT_HOURS = 48;

export interface DoctorRecordingSlice {
  /** The latest recorded backup run, or null when none was ever recorded (backups never armed or never ran). */
  backup: {
    /** `synced` (clean), `needs_review` (completed with a warning) or `failed`. */
    status: string;
    lastRunAt: string;
    lastSuccessAt: string | null;
  } | null;
  phonePing: {
    /** True when the portal has a ping token, so the channel is expected to be in use. */
    configured: boolean;
    /** Server receipt time of the latest phone ping; null when it never pinged. */
    lastPingAt: string | null;
  };
}

function ms(value: string | null): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

function age(from: number, now: number): string {
  const hours = Math.round((now - from) / HOUR_MS);
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`;
}

export function recordingItems(slice: DoctorRecordingSlice, nowMs: number): DoctorItem[] {
  const items: DoctorItem[] = [];
  const { backup, phonePing } = slice;
  if (backup === null) {
    items.push({
      id: "backup_never",
      check: "backup_never",
      tier: "degrading",
      area: "integrations",
      title: "Backups are off",
      why: "If the database is lost, everything in the plan goes with it; no backup has ever run.",
      handles: [],
      fix: {
        who: "person",
        question:
          "Turn backups on by setting BACKUP_ENABLED=true in .env, then run one to prove it. The self-hosting guide (docs/operations/self-hosting.md, Backups) has the steps."
      }
    });
  } else {
    const success = ms(backup.lastSuccessAt);
    if (backup.status === "needs_review")
      items.push({
        id: "backup_warning",
        check: "backup_warning",
        tier: "degrading",
        area: "integrations",
        title: "The last backup finished with a warning",
        why: "A backup exists but something about it (the off-machine copy or the restore check) needs a look.",
        handles: [],
        since: backup.lastRunAt,
        fix: { who: "person", question: "Look at the backup service logs and say what the warning was." }
      });
    if (success === undefined || nowMs - success > DOCTOR_BACKUP_STALE_HOURS * HOUR_MS)
      items.push({
        id: "backup_stale",
        check: "backup_stale",
        tier: "blocking",
        area: "integrations",
        title: success === undefined ? "No backup has succeeded" : `No successful backup for ${age(success, nowMs)}`,
        why: "The newest recoverable copy of the plan is older than a night.",
        handles: [],
        ...(success === undefined ? {} : { since: new Date(success).toISOString() }),
        fix: { who: "person", question: "Check why the nightly backup is not succeeding." }
      });
  }
  const ping = ms(phonePing.lastPingAt);
  if (phonePing.configured && ping !== undefined && nowMs - ping > DOCTOR_PING_SILENT_HOURS * HOUR_MS)
    items.push({
      id: "location_ping_silent",
      check: "location_ping_silent",
      tier: "degrading",
      area: "integrations",
      title: `The phone has not pinged its location for ${age(ping, nowMs)}`,
      why: "Place changes are not being reported, so travel and what can be done here are planned from an old place.",
      handles: [],
      since: new Date(ping).toISOString(),
      fix: { who: "person", question: "Check the Shortcuts location automation on the phone is still running." }
    });
  return items;
}
