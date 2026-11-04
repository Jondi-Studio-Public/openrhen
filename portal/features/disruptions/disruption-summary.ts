import type { PortalState, StoredCommitment } from "@/state/portal-state";
import { isClosedStatus } from "@openrhen/contracts";
import { localDayKey } from "@/features/today/today-view";

/**
 * The disruption to talk about today, or null when there is none. Now and Today both call this
 * rather than each filtering `state.commitments` themselves, which is what keeps "Replanned around
 * X" on Now and the "What changed" panel on Today pointed at the same record.
 *
 * "Today" is `landedAt`'s local day, not `startsAt`'s: a retro-log's `startsAt` sits in the past, and
 * what makes it today's news is that it was written down today. A disruption still under way — now
 * inside its own [startsAt, endsAt) — wins over an older one; failing that, whichever landed most
 * recently is the one still worth a mention.
 */
export function activeDisruption(state: PortalState, now: Date): StoredCommitment | null {
  const timezone = state.settings.timezone;
  const today = localDayKey(now, timezone);
  const landedToday = state.commitments.filter(
    (commitment) =>
      commitment.origin === "disruption" &&
      !isClosedStatus(commitment.status) &&
      commitment.landedAt &&
      localDayKey(new Date(commitment.landedAt), timezone) === today
  );
  if (landedToday.length === 0) return null;
  const live = landedToday.find(
    (commitment) =>
      new Date(commitment.startsAt).getTime() <= now.getTime() && now.getTime() < new Date(commitment.endsAt).getTime()
  );
  if (live) return live;
  return [...landedToday].sort((a, b) => new Date(b.landedAt!).getTime() - new Date(a.landedAt!).getTime())[0] ?? null;
}
