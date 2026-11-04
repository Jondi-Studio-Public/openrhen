import type { LeaveByLeg } from "@openrhen/contracts";

/**
 * Composes the leave-by push/banner text once, server-side, so the push notification and the
 * handheld banner (`device-now.ts`'s `leaveBy.title`) always say the same thing
 *
 */

export interface LeaveByCopy {
  title: string;
  body: string;
}

function minutesLine(leg: LeaveByLeg): string {
  return leg.typicalMinutes !== leg.allowingMinutes
    ? `usually ${leg.typicalMinutes} min, allowing ${leg.allowingMinutes}`
    : `${leg.allowingMinutes} min`;
}

function clock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit", hourCycle: "h23" }).format(
    date
  );
}

export function reminderCopy(leg: LeaveByLeg, timeZone: string): LeaveByCopy {
  return {
    title: `Leave by ${clock(leg.leaveBy, timeZone)} for ${leg.title}`,
    body: minutesLine(leg)
  };
}

export function assumedOriginCopy(leg: LeaveByLeg, assumedLocationName: string, timeZone: string): LeaveByCopy {
  return {
    title: `Leave by ${clock(leg.leaveBy, timeZone)} for ${leg.title}`,
    body: `Assuming you’re at ${assumedLocationName}. Tap to confirm.`
  };
}

export function earlierCopy(leg: LeaveByLeg, minutesEarlier: number, timeZone: string): LeaveByCopy {
  return {
    title: `Leave ${minutesEarlier} min earlier, by ${clock(leg.leaveBy, timeZone)} for ${leg.title}`,
    body: minutesLine(leg)
  };
}

export function dueCopy(leg: LeaveByLeg, arriveBy: Date, timeZone: string): LeaveByCopy {
  return {
    title: `Time to leave for ${leg.title}`,
    body: `Arrive by ${clock(arriveBy, timeZone)}`
  };
}

/** The replacement for an already-delivered prompt whose leg was then cancelled or moved (same tag). */
export function retractionCopy(leg: LeaveByLeg, reason: "cancelled" | "moved"): LeaveByCopy {
  const what = leg.title || "this commitment";
  return reason === "cancelled"
    ? { title: `Cancelled: ${what}`, body: "No need to leave for this one." }
    : { title: `Moved: ${what}`, body: "The earlier leave-by no longer applies. Check Now for the new time." };
}

/** `leave-by:<commitmentId>:<occurrenceStartsAt>:<kind>` — reminder/assumed_origin share `lead`. */
export function leaveByDedupeKey(
  commitmentId: string,
  occurrenceStartsAt: string,
  kind: "lead" | "earlier" | "due" | "cancelled"
): string {
  return `leave_by:${commitmentId}:${occurrenceStartsAt}:${kind}`;
}

/** `leave-by:<commitmentId>:<occurrenceStartsAt>` — the notification `tag` a newer prompt replaces. */
export function leaveByTag(commitmentId: string, occurrenceStartsAt: string): string {
  return `leave-by:${commitmentId}:${occurrenceStartsAt}`;
}
