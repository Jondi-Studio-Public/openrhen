"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { ArrivalButton } from "@/components/situation-panel";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/field";
import { createClientId } from "@/shared/client-id";
import type { ActiveSession, PortalState, StoredSleepPlan } from "@/state/portal-state";
import { clock, formatRemaining } from "@/features/now/now-formatting";
import type { RunActivityCommand, SaveEntityCommand } from "@/features/now/now-model";
import { extendDisruption, isOpenEndedDisruption } from "@/features/disruptions/disruption-commands";
import { dateInput, iso } from "@/features/today/local-datetime";
import { awakeCommand } from "@/features/now/wake-commands";
import { SessionProgress } from "./session-progress";
import styles from "./activity-session-panel.module.css";

/** The "Woke earlier" shortcuts, in minutes before now. */
const WOKE_EARLIER_CHOICES = [
  { minutes: 15, label: "15 min" },
  { minutes: 30, label: "30 min" },
  { minutes: 60, label: "1 h" }
] as const;

/**
 * Sleep, a routine, a single routine step, or a tracked commitment in progress. These share one
 * panel because the person is doing a protected thing, not choosing work: the panel reports the
 * countdown and offers only the ways that thing can end: one primary "Done" (or its sleep and anchor
 * wording), Pause beside it, and the rare exits (Blocked, Skip, Did not start) folded under
 * "Something else" so they never compete with the one you want nine times in ten.
 */
export function ActivitySessionPanel({
  session,
  state,
  now,
  timezone,
  saving,
  secondsRemaining,
  activeSleepPlan,
  serverClock = () => new Date(),
  runActivityCommand,
  saveEntityCommand
}: {
  session: ActiveSession;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  secondsRemaining: number;
  activeSleepPlan: StoredSleepPlan | undefined;
  /** The server's clock as best the browser can tell; "Woke earlier" times are made and checked against it. */
  serverClock?: () => Date;
  runActivityCommand: RunActivityCommand;
  saveEntityCommand: SaveEntityCommand;
}) {
  const trackedCommitment =
    session.targetType === "fixed_commitment"
      ? state.commitments.find((item) => item.id === session.targetId)
      : undefined;
  // An engagement session against an anchor is the person saying the hour is taken up after all, so
  // finishing it is not "confirm and finish" — it is saying you are free, and suggestions come back.
  const engagedAnchor = trackedCommitment?.presence === "anchor";
  // The clock is being held open on a guess, not a fact: this is the only place that
  // guess is reachable while its timer is actually running, since `ProtectedCommitmentPanel`'s own
  // "Done, heading home" / "Still out" controls only render once nothing is being tracked. Finishing here
  // with "Done" already resolves the guess itself (`activity-commands.ts`), so the one
  // affordance genuinely missing is stretching it further without ending the timer.
  const openEndedDisruption = Boolean(trackedCommitment && isOpenEndedDisruption(trackedCommitment));
  const trackedLocation = trackedCommitment?.locationId
    ? state.conditionDefinitions.find((entry) => entry.id === trackedCommitment.locationId)
    : undefined;
  const [extending, setExtending] = useState(false);
  const moreRef = useRef<HTMLDetailsElement>(null);
  useDismissable(moreRef);
  const [extendError, setExtendError] = useState("");
  const [pickingWake, setPickingWake] = useState(false);
  const [wokeAtInput, setWokeAtInput] = useState("");
  const isSleep = session.targetType === "sleep";
  /**
   * I'm awake, now or at a time already gone. The server re-states the place slept in at the wake time,
   * so a night does not leave "Still at Home?" behind.
   */
  async function wake(endedAt?: string) {
    try {
      await runActivityCommand(awakeCommand(session, endedAt));
    } catch {
      // Already on the provider's banner; do not also leave it unhandled.
    }
  }
  const startedMs = new Date(session.startedAt).getTime();
  async function stillOut() {
    if (!trackedCommitment) return;
    setExtending(true);
    const message = await extendDisruption(trackedCommitment, 60, { state, now, saveEntityCommand });
    setExtending(false);
    setExtendError(message);
  }
  return (
    <>
      <div className="status-row">
        <p className="eyebrow">
          {session.targetType === "sleep"
            ? "Sleeping"
            : session.status === "paused"
              ? "Paused"
              : session.targetType === "fixed_commitment"
                ? "Tracking time"
                : "Routine in progress"}
        </p>
        <time dateTime={now.toISOString()}>{clock(now, timezone)}</time>
      </div>
      <h1>{session.targetTitle ?? (session.targetType === "sleep" ? "Sleep" : "Required preparation")}</h1>
      <p className={`countdown${secondsRemaining < 0 ? " overtime" : ""}`}>{formatRemaining(secondsRemaining)}</p>
      {session.targetType !== "sleep" && (
        <SessionProgress secondsRemaining={secondsRemaining} plannedMinutes={session.plannedMinutes} />
      )}
      {activeSleepPlan?.minimumShortfallMinutes ? (
        <section className="sleep-warning" role="alert">
          <h2>Minimum sleep cannot be met</h2>
          <p>
            This sleep is {activeSleepPlan.minimumShortfallMinutes} minutes below your configured minimum because of{" "}
            {activeSleepPlan.wakeConstraint?.title ?? "a confirmed commitment"}.
          </p>
        </section>
      ) : null}
      <p className="reason">
        {session.targetType === "sleep"
          ? "Sleep time is protected. Record when you actually wake so the awake-hours rule remains accurate."
          : openEndedDisruption
            ? "This is held open on a guess, not a fact. Done ends it here too."
            : engagedAnchor
              ? "Nothing else is offered while you’re engaged in this. Say when you’re free and suggestions come back."
              : session.targetType === "fixed_commitment"
                ? "This time is protected either way. Tracking it just keeps your history accurate."
                : "Press Done when the step finishes. If the step stands in for a recurring action, that is done for today too."}
      </p>
      {trackedLocation && trackedLocation.id !== state.currentSituation.locationId && (
        <div className="actions">
          <ArrivalButton
            state={state}
            saving={saving}
            locationId={trackedLocation.id}
            locationName={trackedLocation.name}
            saveEntityCommand={saveEntityCommand}
          />
        </div>
      )}
      {openEndedDisruption && (
        <div className="actions">
          <button type="button" className="quiet small" disabled={extending || saving} onClick={() => void stillOut()}>
            Still out — another hour
          </button>
        </div>
      )}
      {extendError && (
        <p className="form-error" role="alert">
          {extendError}
        </p>
      )}
      <div className="actions session-actions">
        <button
          disabled={saving}
          onClick={() =>
            isSleep
              ? void wake()
              : void runActivityCommand({
                  commandId: createClientId(),
                  expectedVersion: session.version ?? null,
                  type: "finish_activity",
                  sessionId: session.id,
                  outcome: "completed"
                })
          }
        >
          {isSleep ? "I’m awake" : engagedAnchor ? "I’m free" : "Done"}
        </button>
        {session.targetType !== "sleep" && (
          <button
            className="quiet"
            disabled={saving}
            onClick={() =>
              void runActivityCommand({
                commandId: createClientId(),
                expectedVersion: session.version ?? null,
                type: session.status === "paused" ? "resume_activity" : "pause_activity",
                sessionId: session.id
              })
            }
          >
            {session.status === "paused" ? "Resume" : "Pause"}
          </button>
        )}
        <details className="session-more" ref={moreRef}>
          <summary>Something else</summary>
          <div className="alternative-list">
            {session.targetType !== "sleep" && (
              <button
                className="quiet"
                disabled={saving}
                onClick={() =>
                  void runActivityCommand({
                    commandId: createClientId(),
                    expectedVersion: session.version ?? null,
                    type: "finish_activity",
                    sessionId: session.id,
                    outcome: "blocked",
                    note: "Routine could not continue."
                  })
                }
              >
                Blocked
              </button>
            )}
            {session.targetType === "routine_step" && (
              <button
                className="quiet"
                disabled={saving}
                onClick={() =>
                  void runActivityCommand({
                    commandId: createClientId(),
                    expectedVersion: session.version ?? null,
                    type: "finish_activity",
                    sessionId: session.id,
                    outcome: "skipped"
                  })
                }
              >
                Skip
              </button>
            )}
            <button
              className="quiet"
              disabled={saving}
              onClick={() =>
                void runActivityCommand({
                  commandId: createClientId(),
                  expectedVersion: session.version ?? null,
                  type: "finish_activity",
                  sessionId: session.id,
                  outcome: "did_not_start"
                })
              }
            >
              {session.targetType === "sleep" ? "Did not sleep" : "Did not start"}
            </button>
          </div>
        </details>
      </div>
      {isSleep && (
        <div className={styles.wokeEarlier} role="group" aria-label="Woke earlier">
          <span className={styles.wokeLabel}>Woke earlier?</span>
          {WOKE_EARLIER_CHOICES.map((choice) => {
            const endedAtMs = serverClock().getTime() - choice.minutes * 60_000;
            return (
              <Button
                key={choice.minutes}
                size="sm"
                variant="secondary"
                disabled={saving || endedAtMs <= startedMs}
                onClick={() => void wake(new Date(serverClock().getTime() - choice.minutes * 60_000).toISOString())}
              >
                {choice.label} ago
              </Button>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={pickingWake}
            disabled={saving}
            onClick={() => setPickingWake((open) => !open)}
          >
            Pick a time
          </Button>
          {pickingWake && (
            <div className={styles.wokeAt}>
              <Field label="I woke at">
                <input
                  type="datetime-local"
                  value={wokeAtInput}
                  min={dateInput(session.startedAt, timezone)}
                  max={dateInput(serverClock().toISOString(), timezone)}
                  onChange={(event) => setWokeAtInput(event.target.value)}
                />
              </Field>
              <Button
                size="sm"
                variant="secondary"
                disabled={
                  saving || !wokeAtInput || !validWokeAt(wokeAtInput, timezone, startedMs, serverClock().getTime())
                }
                onClick={() => void wake(iso(wokeAtInput, timezone))}
              >
                Save wake time
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** A picked wake time the server will take: after the sleep began, and not in the future. */
function validWokeAt(value: string, timezone: string, startedMs: number, nowMs: number): boolean {
  const at = new Date(iso(value, timezone)).getTime();
  return Number.isFinite(at) && at > startedMs && at <= nowMs;
}

/** Closes a `<details>` menu on a tap outside it or on Escape, the way a menu is expected to behave. */
function useDismissable(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    function close(event: PointerEvent | KeyboardEvent) {
      const details = ref.current;
      if (!details?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        details.open = false;
        details.querySelector("summary")?.focus();
        return;
      }
      if (!details.contains(event.target as Node)) details.open = false;
    }
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [ref]);
}
