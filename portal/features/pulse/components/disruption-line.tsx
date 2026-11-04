"use client";

import { useEffect, useRef, useState } from "react";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { useNow } from "@/shared/clock";
import { usePortal } from "@/state/portal-provider";
import { clock } from "@/features/now/now-formatting";
import { endDisruptionBody, postDisruption } from "../disruption-client";
import { rememberDisruption, useRecordedDisruption } from "../disruption-undo";
import { postRevert } from "../reentry-client";
import styles from "./reentry-panel.module.css";

/** The disruption in force: the state's own, or (until the recorder moves the pulse) this tab's just-recorded one. */
export function useInForceDisruption() {
  const { state } = usePortal();
  const now = useNow("minute");
  const recorded = useRecordedDisruption();
  // The state's own record once the recorder has moved the pulse; until then what this tab just recorded.
  const stillRunning = recorded !== null && new Date(recorded.until).getTime() > now.getTime();
  // The state's record counts only until its own `until`; an expired one is not in force.
  const own = state.pulse?.disruption;
  const ownInForce = own && new Date(own.until).getTime() > now.getTime() ? own : null;
  return { recorded, stillRunning, ownInForce, disruption: ownInForce ?? (stillRunning ? recorded : null) };
}

/**
 * While a recorded disruption holds the pulse on plan: what you are doing instead and until when, with End (it is
 * over now) and, in the tab that recorded it, Undo (it never happened). Renders nothing otherwise.
 */
export function DisruptionLine() {
  const { state, acceptServerState } = usePortal();
  const { recorded, stillRunning, ownInForce, disruption } = useInForceDisruption();
  // Drop the local fallback once it is spent: it ran out, or the state held the disruption and has since lost it.
  const seenInState = useRef(false);
  useEffect(() => {
    if (ownInForce) seenInState.current = true;
    else if (recorded && (!stillRunning || seenInState.current)) {
      seenInState.current = false;
      rememberDisruption(null);
    }
  }, [ownInForce, recorded, stillRunning]);
  const undoTarget = recorded?.commandId ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!disruption) return null;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      rememberDisruption(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That did not save.");
    } finally {
      setBusy(false);
    }
  }
  const end = () =>
    run(async () => {
      const done = await postDisruption(endDisruptionBody());
      if (done.state) acceptServerState(done.state);
    });
  const undo = () =>
    run(async () => {
      const next = await postRevert(undoTarget!);
      if (next) acceptServerState(next);
    });

  return (
    <Banner
      tone="info"
      action={
        <span className={styles.actions}>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void end()}>
            It&apos;s over
          </Button>
          {undoTarget && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undo()}>
              Undo
            </Button>
          )}
        </span>
      }
    >
      On plan, disrupted: {disruption.doing} until {clock(new Date(disruption.until), state.settings.timezone)}.
      {error && <span role="alert"> {error}</span>}
    </Banner>
  );
}
