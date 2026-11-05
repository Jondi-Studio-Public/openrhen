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
    /** True when the latest run kept the backup on this machine only (no copy folder set, and not chosen on purpose). */
    localOnly?: boolean;
    /** True when the latest run could not restore-test the backup (no admin database URL). */
    restoreSkipped?: boolean;
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
      title: "No backup has run yet",
      why: "If the database is lost, everything in the plan goes with it; backups run nightly by default, and none has been recorded.",
      handles: [],
      fix: {
        who: "person",
        question:
          "Backups run on their own at 03:30. If the first night has not passed, wait for it or run one now: docker compose run --rm backup node scripts/backup/backup-and-copy.mjs. If none appears after a night, check that the backup service is running (docker compose logs backup)."
      }
    });
  } else {
    const success = ms(backup.lastSuccessAt);
    if (backup.localOnly)
      items.push({
        id: "backup_local_only",
        check: "backup_local_only",
        tier: "degrading",
        area: "integrations",
        title: "Backups don't leave this machine",
        why: "If this machine's disk is lost, the backups go with it. Nightly backups are kept here only because no copy folder is set.",
        handles: [],
        since: backup.lastRunAt,
        fix: {
          who: "person",
          question:
            "Set BACKUP_COPY_DIR in .env to a folder on another machine or a NAS share (put an empty .openrhen-backup-target file in it), or set BACKUP_COPY=off to accept local-only backups."
        }
      });
    if (backup.restoreSkipped)
      items.push({
        id: "backup_unverified",
        check: "backup_unverified",
        tier: "degrading",
        area: "integrations",
        title: "Backups are not being restore-tested",
        why: "A backup nobody has restored is a guess; the restore check needs POSTGRES_ADMIN_URL and it is not set.",
        handles: [],
        since: backup.lastRunAt,
        fix: {
          who: "person",
          question: "Set POSTGRES_ADMIN_URL in .env (setup writes one) and restart the backup service."
        }
      });
    if (backup.status === "needs_review" && !backup.restoreSkipped)
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
