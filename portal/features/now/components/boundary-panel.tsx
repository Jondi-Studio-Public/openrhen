"use client";

import { createClientId } from "@/shared/client-id";
import type { PortalState } from "@/state/portal-state";
import { clock, localDate } from "@/features/now/now-formatting";
import { nextPlanningWake } from "@/shared/planning-day";
import { localDayKey } from "@/features/today/today-view";
import type { BoundaryDirective, SaveEntityCommand } from "@/features/now/now-model";
import { EvidenceDetails } from "./evidence-details";

/** How much later the person may choose to keep working when the daily horizon is what binds. */
const HORIZON_EXTENSIONS_MINUTES = [60, 120, 180] as const;

function boundaryName(directive: BoundaryDirective): string {
  switch (directive.boundaryKind) {
    case "daily_horizon":
      return "today's planning horizon";
    case "commitment":
      return directive.boundaryTitle ?? "the next commitment";
    case "sleep":
      return directive.boundaryTitle ?? "sleep";
    case "capacity":
      return directive.boundaryTitle ?? "the next capacity opening";
    default:
      return "the next boundary";
  }
}

/**
 * Nothing fits before a boundary — the daily horizon, a commitment, sleep, or a capacity opening —
 * so the directive names the boundary and the first thing that fits after it. When the boundary is
 * today's own horizon, the person may push it out ("work later tonight") through the same daily-plan
 * override the engine already honours; every other boundary is real and is simply waited out.
 */
export function BoundaryPanel({
  directive,
  isDailyHorizon,
  state,
  now,
  timezone,
  saving,
  explanation,
  evidence,
  saveEntityCommand
}: {
  directive: BoundaryDirective;
  isDailyHorizon: boolean;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  explanation: string;
  evidence: readonly string[];
  saveEntityCommand: SaveEntityCommand;
}) {
  const boundaryAt = new Date(directive.boundaryAt);
  const sameDay = (date: Date) => localDayKey(date, timezone) === localDayKey(now, timezone);
  const when = (date: Date) =>
    sameDay(date) ? clock(date, timezone) : `${clock(date, timezone)} on ${localDate(date, timezone)}`;
  const nextFit = directive.nextFit;
  const todayKey = localDayKey(now, timezone);
  const existingPlan = state.dailyPlan?.localDate === todayKey ? state.dailyPlan : undefined;
  // The extension is measured from the boundary when it is still ahead, and from now once the
  // horizon has already passed — otherwise "one more hour" after a 22:00 horizon at 23:30 would end
  // in the past and change nothing.
  const extendFrom = Math.max(boundaryAt.getTime(), now.getTime());
  // An extension is for the planning day it is made in, so it stops at the next wake: past it the day
  // that begins then would inherit it. Options that would run past the wake collapse into one that
  // ends there.
  const wakeAt = nextPlanningWake(now, state.settings, state.dailyPlan);
  const extensions: { at: Date; minutes: number; clamped: boolean }[] = [];
  for (const minutes of HORIZON_EXTENSIONS_MINUTES) {
    const clamped = extendFrom + minutes * 60_000 > wakeAt.getTime();
    const at = clamped ? wakeAt : new Date(extendFrom + minutes * 60_000);
    if (at.getTime() <= extendFrom || extensions.some((option) => option.at.getTime() === at.getTime())) continue;
    extensions.push({ at, minutes, clamped });
  }
  const extendHorizon = (at: Date) =>
    void saveEntityCommand({
      commandId: createClientId(),
      expectedVersion: existingPlan?.version ?? null,
      type: "save_entity",
      entityType: "daily_plan",
      entity: {
        localDate: todayKey,
        desiredActionIds: existingPlan?.desiredActionIds ?? [],
        deferredItems: existingPlan?.deferredItems ?? [],
        horizonOverrideAt: at.toISOString()
      }
    });
  return (
    <>
      <p className="time">
        {directive.boundaryEdge === "end"
          ? `Nothing fits until ${boundaryName(directive)}'s protection ends`
          : `Nothing fits before ${boundaryName(directive)}`}{" "}
        · {when(boundaryAt)}
      </p>
      <p className="reason">{explanation}</p>
      {nextFit ? (
        <p className="microcopy">
          Next fit: <strong>{nextFit.title}</strong> for {nextFit.recommendedMinutes} minutes at{" "}
          {when(new Date(nextFit.at))}.
        </p>
      ) : (
        <p className="microcopy">Nothing after it fits inside the forecast either.</p>
      )}
      {isDailyHorizon && extensions.length > 0 && (
        <div className="actions horizon-extension">
          <span>Work later tonight:</span>
          {extensions.map((option) => (
            <button className="quiet" disabled={saving} key={option.minutes} onClick={() => extendHorizon(option.at)}>
              {option.clamped
                ? `until ${clock(option.at, timezone)}`
                : `+${option.minutes / 60} ${option.minutes === 60 ? "hour" : "hours"}`}
            </button>
          ))}
          <small className="microcopy">
            Moves today&apos;s horizon to {when(extensions[0]!.at)} or later, never past your wake time; the plan
            re-runs against it.
          </small>
        </div>
      )}
      {evidence.length > 0 && <EvidenceDetails summary="Why nothing fits before then" evidence={evidence} />}
    </>
  );
}
