import type { StartByWarning } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { clock } from "@/features/now/now-formatting";

/**
 * Every pending step whose latest start is soon or already passed
 * in the order
 * `state.planning.result.startByWarnings` already arrives (sorted by `startBy` across every anchor).
 * Sits above `PrepPaceBanner` on Now. Renders nothing when there are none.
 *
 * The warning itself carries only the anchor's title, not its time; a commitment anchor's own
 * `startsAt` is looked up here so the line can name it ("for Work at 07:00"), the way the prep-pace
 * banner already names its commitment's start. A sleep anchor (bedtime/wake) has no such lookup yet,
 * so its line names only the anchor.
 */
export function StartByBanner({
  warnings,
  state,
  timezone
}: {
  warnings: StartByWarning[];
  state: PortalState;
  timezone: string;
}) {
  if (!warnings.length) return null;
  return (
    <section className="start-by-banner" role="status">
      {warnings.map((warning) => {
        const startBy = clock(new Date(warning.startBy), timezone);
        const anchorCommitment = state.commitments.find((item) => item.id === warning.anchorId);
        const anchor = anchorCommitment
          ? `${warning.anchorTitle} at ${clock(new Date(anchorCommitment.startsAt), timezone)}`
          : warning.anchorTitle;
        const text = `${warning.status === "missed" ? "Missed: start" : "Start"} ${warning.title} by ${startBy} — for ${anchor}`;
        return (
          <p key={warning.stepId} className={warning.status === "missed" ? "missed" : "soon"}>
            {text}
          </p>
        );
      })}
    </section>
  );
}
