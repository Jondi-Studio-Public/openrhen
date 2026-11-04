"use client";

import { useEffect, useRef, useState } from "react";
import type { ActiveSession, PortalState, StoredAction } from "@/state/portal-state";
import { Button } from "@/components/ui/button";
import { cx } from "@/components/ui/cx";
import { clock, formatRemaining, projectTitle } from "@/features/now/now-formatting";
import { SessionProgress } from "./session-progress";
import { startFloor } from "@/features/now/logged-session";
import { StartedEarlier, startedAtFor, startedEarlierProblem, type StartedEarlierChoice } from "./started-earlier";
import { SwitchToSheet } from "./switch-to-sheet";
import styles from "../now-page.module.css";
import logging from "../session-logging.module.css";

/**
 * A project action being worked on: the countdown is the page. "Done" is the one primary: it opens the
 * checkpoint, where finished, progress, stuck and didn't-start are each answered, so the rare exits
 * need no button here. Pause sits beside it, and Switch to hands the session to another task. If the
 * work began before Start was tapped, "Started earlier?" moves the start back.
 */
export function ActionSessionPanel({
  session,
  sessionAction,
  state,
  now,
  timezone,
  saving,
  secondsRemaining,
  plannedStart,
  plannedEnd,
  onPauseOrResume,
  onRequestFeedback,
  onCorrectStart,
  onSwitch,
  focusOnMount,
  onFocused
}: {
  session: ActiveSession;
  sessionAction: StoredAction;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  secondsRemaining: number;
  plannedStart: Date;
  plannedEnd: Date;
  plannedDuration: number;
  onPauseOrResume: () => void;
  onRequestFeedback: () => void;
  /** Moves the start of this session earlier (`correct_start`). Absent hides "Started earlier?". */
  onCorrectStart?: (startedAt: string) => Promise<void>;
  /** Ends this session keeping its estimate and hands over to Something else. Absent hides "Switch to". */
  onSwitch?: () => Promise<void>;
  /** This session was started by a switch: its card takes focus, as the buttons that started it are gone. */
  focusOnMount?: boolean;
  onFocused?: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    headingRef.current?.focus();
    onFocused?.();
  }, [focusOnMount, onFocused]);
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [earlier, setEarlier] = useState<StartedEarlierChoice | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const floor = startFloor(state);
  const movedStart = startedEarlierProblem(earlier, now, timezone, floor, plannedStart)
    ? undefined
    : startedAtFor(earlier, now, timezone);
  const paused = session.status === "paused";
  const area = projectTitle(state, sessionAction.projectId);
  return (
    <>
      <p className={styles.kicker}>
        <span className={styles.ring} aria-hidden="true" />
        {paused ? "Paused" : "In progress"}
        {` · started ${clock(plannedStart, timezone)}`}
      </p>
      <div className={styles.heading}>
        <h1 ref={headingRef} tabIndex={-1}>
          {sessionAction.title}
        </h1>
        {area ? <p className={styles.lead}>{area}</p> : null}
      </div>
      <div className={styles.countdown}>
        <div className={styles.clockLine}>
          <p className={styles.clock} data-overtime={secondsRemaining < 0}>
            {formatRemaining(secondsRemaining)}
          </p>
          <p className={styles.of}>of {session.plannedMinutes} min</p>
        </div>
        <SessionProgress secondsRemaining={secondsRemaining} plannedMinutes={session.plannedMinutes} />
        <p className={styles.caption}>
          {secondsRemaining < 0
            ? "Past the checkpoint. Overrunning is fine; say how it went when you stop."
            : `A checkpoint asks how it went at ${clock(plannedEnd, timezone)}. Paused time doesn't count.`}
        </p>
      </div>
      <div className={cx("actions", styles.actions)}>
        <Button variant="primary" size="lg" className={styles.start} disabled={saving} onClick={onRequestFeedback}>
          Done
        </Button>
        <Button variant="secondary" size="lg" disabled={saving} onClick={onPauseOrResume}>
          {paused ? "Resume" : "Pause"}
        </Button>
      </div>
      {onSwitch || onCorrectStart ? (
        <div className={logging.more}>
          {onSwitch ? (
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="dialog"
              disabled={saving}
              onClick={() => setSwitchOpen(true)}
            >
              Switch to…
            </Button>
          ) : null}
          {onCorrectStart ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={earlierOpen}
              onClick={() => setEarlierOpen((current) => !current)}
            >
              Started earlier?
            </Button>
          ) : null}
        </div>
      ) : null}
      {onCorrectStart && earlierOpen ? (
        <div className={logging.correct}>
          <StartedEarlier
            choice={earlier}
            onChange={setEarlier}
            now={now}
            timezone={timezone}
            before={plannedStart}
            floor={floor}
          />
          <Button
            variant="secondary"
            disabled={saving || !movedStart}
            onClick={() => {
              if (!movedStart) return;
              void onCorrectStart(movedStart)
                .then(() => {
                  setEarlier(null);
                  setEarlierOpen(false);
                })
                .catch(() => undefined);
            }}
          >
            Move the start
          </Button>
        </div>
      ) : null}
      {onSwitch ? (
        <SwitchToSheet
          open={switchOpen}
          onClose={() => setSwitchOpen(false)}
          title={sessionAction.title}
          keepMinutes={sessionAction.remainingMinutes > 0 ? sessionAction.remainingMinutes : null}
          saving={saving}
          onSwitch={onSwitch}
        />
      ) : null}
    </>
  );
}
