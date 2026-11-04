"use client";

import { useState } from "react";
import { createClientId } from "@/shared/client-id";
import type {
  ActiveSession,
  PortalState,
  StoredCommitment,
  StoredRoutineStep,
  StoredSleepPlan
} from "@/state/portal-state";
import { clock, hoursMinutes, wallClock } from "@/features/now/now-formatting";
import type { NowCandidate, RunActivityCommand, SaveEntityCommand, SleepSuggestion } from "@/features/now/now-model";
import type { StayUpOffer as StayUpOfferData } from "@openrhen/contracts";
import { BedtimeStepCard } from "./bedtime-step-card";
import { BedtimeStepSessionCard } from "./bedtime-step-session-card";
import { StayUpOffer } from "./stay-up-offer";

/** The minutes a nap box suggests when there is no shortfall to top up. */
const NAP_PLACEHOLDER_MINUTES = 30;

/**
 * Sleep that is due, or has been started early on purpose. While a bedtime routine has a step left
 * the panel shows that step instead of the start button, so the routine is worked through in order.
 */
export function SleepPanel({
  sleepDue,
  state,
  timezone,
  now,
  saving,
  manualBedtime,
  sleepPanelDue,
  sleepEarlyStart,
  sleepMinutesUntilPlannedStart,
  sleepEarlyStartWakeAt,
  sleepConstrainedMinutes,
  sleepNapTopUpMinutes,
  onCancelManualBedtime,
  tentativeSleepConflict,
  wakeToCommitmentMinutes,
  commitmentAfterWake,
  wakeShiftMinutes,
  stepSession,
  secondsRemaining,
  currentBedtimeStep,
  primary,
  sleepSuggestion,
  stayUpOffer,
  runActivityCommand,
  saveEntityCommand
}: {
  sleepDue: StoredSleepPlan;
  state: PortalState;
  timezone: string;
  now: Date;
  saving: boolean;
  manualBedtime: boolean;
  sleepPanelDue: boolean;
  sleepEarlyStart: boolean;
  sleepMinutesUntilPlannedStart: number;
  sleepEarlyStartWakeAt: string | undefined;
  sleepConstrainedMinutes: number | undefined;
  sleepNapTopUpMinutes: number | undefined;
  onCancelManualBedtime: () => void;
  tentativeSleepConflict: StoredCommitment | undefined;
  wakeToCommitmentMinutes: number | undefined;
  commitmentAfterWake: StoredCommitment | undefined;
  wakeShiftMinutes: number;
  stepSession: ActiveSession | undefined;
  secondsRemaining: number;
  currentBedtimeStep: StoredRoutineStep | undefined;
  primary: NowCandidate | null;
  sleepSuggestion: SleepSuggestion | undefined;
  stayUpOffer: StayUpOfferData | undefined;
  runActivityCommand: RunActivityCommand;
  saveEntityCommand: SaveEntityCommand;
}) {
  // Typed rather than parsed into a number as it goes, so a half-deleted entry ("" or "4") is the
  // person's business and not a reason to fall back to the offered default mid-keystroke.
  const [napMinutesInput, setNapMinutesInput] = useState("");
  const desiredSleepMinutes = state.settings.desiredSleepMinutes;
  const customNapMinutes = Number.parseInt(napMinutesInput, 10);
  const napMinutes =
    Number.isFinite(customNapMinutes) && customNapMinutes > 0 ? customNapMinutes : sleepNapTopUpMinutes;
  // Falls back to the desired amount outside an early start, where this figure is never rendered
  // anyway; the model always sets it alongside `sleepEarlyStart`.
  const constrainedMinutes = sleepConstrainedMinutes ?? desiredSleepMinutes;
  // The constraint only "binds" when it actually shortened the offer below the desired amount —
  // otherwise there is nothing to explain and the option is a plain full sleep.
  const constrainedBinds = Boolean(sleepDue.wakeConstraint) && constrainedMinutes < desiredSleepMinutes;
  /** Every duration this panel offers is stated as the clock time it would actually end at. */
  const endsAt = (minutes: number) => clock(new Date(now.getTime() + minutes * 60_000), timezone);
  const startSleep = (plannedMinutes: number) =>
    void runActivityCommand({
      commandId: createClientId(),
      expectedVersion: sleepDue.version ?? null,
      type: "start_activity",
      targetType: "sleep",
      targetId: sleepDue.id,
      plannedMinutes
    });
  const asHours = (minutes: number) => `${Math.round((minutes / 60) * 10) / 10} h`;
  const answerDeviation = (placementChoice: "early" | "near") =>
    void saveEntityCommand({
      commandId: createClientId(),
      expectedVersion: sleepDue.version ?? null,
      type: "save_entity",
      entityType: "sleep_plan",
      entity: { id: sleepDue.id, placementChoice }
    });
  return (
    <>
      {sleepEarlyStart ? (
        // Started hours ahead of the plan, the planned pair would read as a description of sleeping
        // now — a duration and a wake time that cannot both be true from here. Say whose times they
        // are, and how far off that bedtime actually is.
        <p className="time">
          Planned sleep {clock(new Date(sleepDue.plannedStartAt), timezone)} –{" "}
          {clock(new Date(sleepDue.plannedWakeAt), timezone)} ({sleepDue.allowedMinutes} minutes) · bedtime in{" "}
          {hoursMinutes(sleepMinutesUntilPlannedStart)}
        </p>
      ) : (
        <p className="time">
          For {sleepDue.allowedMinutes} minutes · until {clock(new Date(sleepDue.plannedWakeAt), timezone)}
        </p>
      )}
      {sleepDue.minimumShortfallMinutes ? (
        <section className="sleep-warning" role="alert">
          <h2>Minimum sleep cannot be met</h2>
          <p>
            This plan provides {Math.round(sleepDue.allowedMinutes / 6) / 10} hours against your{" "}
            {Math.round(state.settings.minimumSleepMinutes / 6) / 10}-hour minimum, a shortfall of{" "}
            {sleepDue.minimumShortfallMinutes} minutes.
          </p>
          <p>
            {sleepDue.wakeConstraint?.title ?? "A confirmed commitment"} requires you to be available by{" "}
            {clock(new Date(sleepDue.wakeConstraint?.protectedStartAt ?? sleepDue.plannedWakeAt), timezone)}.
          </p>
        </section>
      ) : null}
      {sleepDue.deviationOptions?.warn ? (
        <section className="sleep-warning" role="alert">
          <h2>This night starts well before your usual bedtime</h2>
          <p>
            To get {asHours(sleepDue.deviationOptions.early.minutes)} before{" "}
            {sleepDue.wakeConstraint?.title ?? "the wake"} at{" "}
            {clock(new Date(sleepDue.deviationOptions.early.wakesAt), timezone)}, bed is at{" "}
            {clock(new Date(sleepDue.deviationOptions.early.startsAt), timezone)}. Or sleep{" "}
            {clock(new Date(sleepDue.deviationOptions.near.startsAt), timezone)}–
            {clock(new Date(sleepDue.deviationOptions.near.wakesAt), timezone)} for{" "}
            {asHours(sleepDue.deviationOptions.near.minutes)}.
          </p>
          <div className="actions">
            <button disabled={saving} onClick={() => answerDeviation("early")}>
              Go to bed early
            </button>
            <button className="quiet" disabled={saving} onClick={() => answerDeviation("near")}>
              Keep this night
            </button>
          </div>
        </section>
      ) : null}
      {stayUpOffer ? (
        <StayUpOffer
          offer={stayUpOffer}
          sleepDue={sleepDue}
          timezone={timezone}
          saving={saving}
          saveEntityCommand={saveEntityCommand}
        />
      ) : null}
      <p className="reason">{sleepDue.explanation}</p>
      {tentativeSleepConflict ? (
        <p className="form-warning">
          Tentative commitment “{tentativeSleepConflict.title}” conflicts with protected sleep. Confirm or reschedule
          it; tentative work does not shorten your minimum sleep.
        </p>
      ) : null}
      {wakeToCommitmentMinutes !== undefined && wakeToCommitmentMinutes <= 12 * 60 ? (
        <p className="microcopy">
          The {clock(new Date(sleepDue.plannedWakeAt), timezone)} wake leaves {wakeToCommitmentMinutes} minutes before{" "}
          {commitmentAfterWake!.title} at {clock(new Date(commitmentAfterWake!.startsAt), timezone)}.
        </p>
      ) : wakeShiftMinutes !== 0 ? (
        <p className="microcopy">
          Your preferred wake is {wallClock(state.settings.preferredWakeTime)}. It moves {Math.abs(wakeShiftMinutes)}{" "}
          minutes {wakeShiftMinutes < 0 ? "earlier" : "later"}{" "}
          {sleepDue.wakeConstraint
            ? `because ${sleepDue.wakeConstraint.title ?? "a confirmed commitment"} requires you to be available by ${clock(
                new Date(sleepDue.wakeConstraint.protectedStartAt),
                timezone
              )}.`
            : "because protected sleep duration takes priority after a missed start."}
        </p>
      ) : null}
      {sleepDue.hardErrors.map((error) => (
        <p className="form-error" key={error}>
          {error}
        </p>
      ))}
      {manualBedtime && !sleepPanelDue ? (
        <p className="microcopy">
          Started early by choice — this is not yet the engine’s scheduled bedtime.{" "}
          <button className="quiet" disabled={saving} onClick={onCancelManualBedtime}>
            Not ready yet
          </button>
        </p>
      ) : null}
      {stepSession ? (
        <BedtimeStepSessionCard
          stepSession={stepSession}
          secondsRemaining={secondsRemaining}
          saving={saving}
          runActivityCommand={runActivityCommand}
        />
      ) : currentBedtimeStep ? (
        <BedtimeStepCard
          step={currentBedtimeStep}
          label="before sleep"
          saving={saving}
          runActivityCommand={runActivityCommand}
        />
      ) : (
        <>
          <details className="calculation-details">
            <summary>What would I do if sleep were not due?</summary>
            {primary ? (
              <>
                <p>{primary.action.title}</p>
                <p className="microcopy">
                  {primary.recommendedMinutes} minutes fits your reported {state.currentEnergy} energy and current
                  contexts.
                </p>
              </>
            ) : (
              <p className="microcopy">No project action fits the energy and contexts you reported.</p>
            )}
          </details>
          {sleepEarlyStart ? (
            <>
              {sleepEarlyStartWakeAt ? (
                // Starting early moves the wake, so the plan's own duration is no longer a sleep
                // anyone chose. Say where it would actually land, then ask which sleep this is.
                <p className="microcopy">
                  The planned {sleepDue.allowedMinutes} minutes, begun now, would end around{" "}
                  {clock(new Date(sleepEarlyStartWakeAt), timezone)}, not the planned{" "}
                  {clock(new Date(sleepDue.plannedWakeAt), timezone)} wake. Choose the sleep you mean instead.
                </p>
              ) : null}
              {constrainedBinds ? (
                <p className="microcopy">
                  The wake for {sleepDue.wakeConstraint!.title ?? "a confirmed commitment"} cuts this short of the full{" "}
                  {desiredSleepMinutes} minutes.
                </p>
              ) : null}
              <div className="actions">
                <button disabled={saving} onClick={() => startSleep(constrainedMinutes)}>
                  {constrainedBinds
                    ? `Sleep until ${endsAt(constrainedMinutes)} — ${constrainedMinutes} minutes`
                    : `Full sleep — ${constrainedMinutes} minutes, until ${endsAt(constrainedMinutes)}`}
                </button>
              </div>
              <label className="field">
                <span>Nap minutes</span>
                <input
                  type="number"
                  min="1"
                  inputMode="numeric"
                  placeholder={String(sleepNapTopUpMinutes ?? NAP_PLACEHOLDER_MINUTES)}
                  value={napMinutesInput}
                  onChange={(event) => setNapMinutesInput(event.target.value)}
                />
              </label>
              <p className="microcopy">
                {sleepNapTopUpMinutes
                  ? `${sleepNapTopUpMinutes} minutes brings your last night back up to the ${desiredSleepMinutes} minutes you want. Enter your own to override it.`
                  : `Nothing to top up against the ${desiredSleepMinutes} minutes you want — enter how long this rest should run.`}
              </p>
              <div className="actions">
                <button
                  className="secondary"
                  disabled={saving || !napMinutes}
                  onClick={() => napMinutes && startSleep(napMinutes)}
                >
                  {napMinutes ? `Nap — ${napMinutes} minutes, until ${endsAt(napMinutes)}` : "Nap — set the minutes"}
                </button>
              </div>
            </>
          ) : (
            <div className="actions">
              <button disabled={saving} onClick={() => startSleep(sleepDue.allowedMinutes)}>
                Start sleep
              </button>
            </div>
          )}
          {sleepSuggestion ? (
            <div className="actions">
              <button
                className="quiet"
                disabled={saving}
                onClick={() =>
                  void saveEntityCommand({
                    commandId: createClientId(),
                    expectedVersion: sleepDue.version ?? null,
                    type: "save_entity",
                    entityType: "sleep_plan",
                    entity: {
                      id: sleepDue.id,
                      plannedStartAt: sleepDue.plannedStartAt,
                      plannedWakeAt: sleepSuggestion.wakeAtIso
                    }
                  })
                }
              >
                {sleepSuggestion.kind === "catchup"
                  ? `Extend by ${sleepSuggestion.addedMinutes} min to catch up on last night's shortfall`
                  : `Shorten to a ${sleepSuggestion.minutes}-minute rest — last sleep already met your goal`}
              </button>
            </div>
          ) : null}
        </>
      )}
    </>
  );
}
