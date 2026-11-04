import { displayLocale } from "@/shared/locale";
import type { PhotoCheckinMode, PhotoCheckinWire } from "@openrhen/contracts";

export const MODE_LABELS: Record<PhotoCheckinMode, string> = {
  off: "Off: receive nothing",
  on: "On: collect and read photos, and prompt hourly"
};

export const STATUS_LABELS: Record<PhotoCheckinWire["status"], string> = {
  pending: "Waiting to be read",
  processed: "Read",
  failed: "Could not be read"
};

/** The timestamp to send for a chosen file: when the phone says it was taken, else now. Always an ISO string. */
export function takenAtFor(file: { lastModified?: number }, now: Date): string {
  const stamp = file.lastModified;
  return new Date(stamp && Number.isFinite(stamp) && stamp > 0 ? stamp : now.getTime()).toISOString();
}

export function formatTaken(iso: string): string {
  return new Date(iso).toLocaleString(displayLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}
