import type { PortalState } from "@/state/portal-state";

/**
 * The short tags a History card shows beside its result. A session started at a past `startedAt`
 * carries `startedRecordedAt`, and its start time is
 * recorded rather than watched, so the card says so in plain words.
 */
export function sessionTags(session: Pick<PortalState["completedToday"][number], "startedRecordedAt">): string[] {
  return session.startedRecordedAt ? ["Start time entered later"] : [];
}
