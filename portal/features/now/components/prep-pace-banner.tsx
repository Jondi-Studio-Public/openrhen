import type { PrepPace } from "@openrhen/contracts";
import { LetSomeoneKnow } from "@/features/commitments/components/let-someone-know";
import { clock } from "@/features/now/now-formatting";

/**
 * The one thing worth saying before anything else on Now: the engine has already worked out that
 * getting ready for the next fixed commitment will not fit in the time left (`behind`), or is about
 * to stop fitting (`tight`). Read straight off `NowModel.prepPace` — nothing here re-derives the
 * arithmetic; see `engine/core/src/recommendation/prep-pace.ts`. Renders nothing for `on_track` or
 * when nothing is currently being prepared for, so the banner only ever interrupts when there is
 * actually something to say.
 *
 * When the forward simulation projects arriving late (`projectedLateMinutes > 0`,
 * The routine step timing design note "Warnings and arrival projection") the banner says so directly
 * instead of the plainer "behind" wording, and offers `LetSomeoneKnow` for the commitment being
 * prepared for, which opens the same disruption capture sheet
 * the "Something came up" button on Now already opens, with that commitment's contact pre-chosen.
 */
export function PrepPaceBanner({ prepPace, timezone }: { prepPace: PrepPace | undefined; timezone: string }) {
  if (!prepPace || prepPace.status === "on_track") return null;
  const at = clock(new Date(prepPace.commitmentStartsAt), timezone);
  const behind = prepPace.status === "behind";
  const projectedLateMinutes = prepPace.projectedLateMinutes ?? 0;
  return (
    <section className={`prep-pace-banner ${behind ? "behind" : "tight"}`} role="status">
      <p className="reason">
        {projectedLateMinutes > 0
          ? `At this pace you'll arrive ~${projectedLateMinutes} min late`
          : behind
            ? `Behind prep pace · ${prepPace.minutesBehind} min behind · ${prepPace.commitmentTitle} at ${at}`
            : `Prep is tight · ${prepPace.availableMinutes - prepPace.requiredMinutes} min spare`}
      </p>
      {projectedLateMinutes > 0 && (
        <LetSomeoneKnow commitmentId={prepPace.commitmentId} reason="late" lateMinutes={projectedLateMinutes} />
      )}
    </section>
  );
}
