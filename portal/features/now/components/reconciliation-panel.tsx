"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { ActiveSession, PortalState } from "@/state/portal-state";
import { createClientId } from "@/shared/client-id";
import { clock, dayClock } from "@/features/now/now-formatting";
import { dateInput, iso } from "@/features/today/local-datetime";
import type { RunActivityCommand } from "@/features/now/now-model";
import { Field } from "@/components/field";

interface TrailRow {
  id: string;
  slotAt: string;
  directiveTitle: string;
}

interface Trail {
  rows: TrailRow[];
  sleepStarts: string[];
}

/**
 * The `answer_check_ins` half of `checkInCommandSchema` (`platform/contracts/src/planning/commands.ts`),
 * kept as a local type rather than imported: the contracts package's `index.ts` only re-exports
 * `CheckInCommand` (the union), not this arm by name, and this task's allowed files do not include
 * that barrel.
 */
interface AnswerCheckInsCommand {
  commandId: string;
  type: "answer_check_ins";
  checkInIds: string[];
  upTo: string;
  tail: {
    status: TailStatus;
    deviationNote?: string;
  };
}

/**
 * Posted straight at the check-in command endpoint, bypassing `usePortal()`'s save path — same
 * reasoning as `features/check-in/check-in-command.ts`'s own `send()`: an answer never touches the
 * plan (Phase A is record-only), so it must not trigger the plan-refresh poll that path exists for.
 * Not imported from that file since it only exports the single-answer helpers and this task's
 * allowed files do not include it.
 */
async function sendAnswerCheckIns(command: AnswerCheckInsCommand): Promise<void> {
  const response = await fetch("/api/commands/check-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  const result = (await response.json().catch(() => ({}))) as { state?: unknown; error?: string };
  if (!response.ok || !result.state) throw new Error(result.error ?? "The check-ins were not saved.");
}

type TailStatus = "on_track" | "deviated" | "unknown";

/**
 * Replaces the deliverable session/checkpoint panel once a session has gone unverified for three or
 * more consecutive hours — see the session reconciliation design note, "On return to a session that
 * has gone unverified." Shows the last moment reconciliation can vouch for, a ladder of the
 * unanswered hours the trail route (`/api/check-ins/trail`, task 002) surfaces, and a proposed end
 * time capped by any recorded sleep. Three actions: end the session at a chosen moment and answer the
 * trail accordingly, declare the whole trail on track and keep working, or open the full workspace
 * card unmodified.
 *
 * Check-ins never act on plan state (Phase A's rule, restated by this design): only `finish_activity`
 * ends the session; `answer_check_ins` only ever writes `check_in` rows.
 */
export function ReconciliationPanel({
  session,
  state,
  now,
  timezone,
  saving,
  runActivityCommand,
  onSettled
}: {
  session: ActiveSession;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
  /** Called once "I was working the whole time" has been recorded, so the page can show the
   *  ordinary session panel again for the rest of this session without waiting on the next poll. */
  onSettled: () => void;
}) {
  const [trail, setTrail] = useState<Trail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [phase, setPhase] = useState<"choose" | "tail">("choose");
  const [endedAtInput, setEndedAtInput] = useState("");
  const [deviationOpen, setDeviationOpen] = useState(false);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || saving;
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setTrail(null);
    setLoadError("");
    fetch(`/api/check-ins/trail?sessionId=${encodeURIComponent(session.id)}`)
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Partial<Trail> & { error?: string };
        if (cancelled) return;
        if (!response.ok || !body.rows) {
          setLoadError(body.error ?? "The trail could not be loaded.");
          return;
        }
        setTrail({ rows: body.rows, sleepStarts: body.sleepStarts ?? [] });
      })
      .catch(() => {
        if (!cancelled) setLoadError("The trail could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  const segmentStartedAt = session.segmentStartedAt ? new Date(session.segmentStartedAt) : new Date(session.startedAt);
  const lastVerifiedAt = session.lastVerifiedAt ? new Date(session.lastVerifiedAt) : segmentStartedAt;
  // "the last verified moment, or one minute past the open segment's start when the two coincide" —
  // they coincide exactly when no on-track answer moved `lastVerifiedAt` past the segment's own
  // start, the motivating case this design exists for.
  const coincide = (session.lastVerifiedAt ?? session.startedAt) === (session.segmentStartedAt ?? session.startedAt);
  const verifiedBy: "on_track" | "segment" | "session_start" = !coincide
    ? "on_track"
    : segmentStartedAt.getTime() !== new Date(session.startedAt).getTime()
      ? "segment"
      : "session_start";

  const proposedEnd = useMemo(() => {
    const base = coincide ? new Date(segmentStartedAt.getTime() + 60_000) : lastVerifiedAt;
    // "A recorded night whose actual_start_at falls after the last verified moment caps the proposed
    // end" — never on status, only ever a recorded (not merely planned) sleep start.
    const sleepCeilings = (trail?.sleepStarts ?? [])
      .map((value) => new Date(value))
      .filter((sleepStart) => sleepStart.getTime() > lastVerifiedAt.getTime());
    const ceiling = sleepCeilings.length
      ? sleepCeilings.reduce((earliest, candidate) => (candidate < earliest ? candidate : earliest))
      : undefined;
    const proposed = ceiling && ceiling.getTime() < base.getTime() ? ceiling : base;
    const floor = new Date(segmentStartedAt.getTime() + 1);
    const ceilingNow = now;
    if (proposed.getTime() <= floor.getTime()) return floor;
    if (proposed.getTime() > ceilingNow.getTime()) return ceilingNow;
    return proposed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail, coincide, lastVerifiedAt.getTime(), segmentStartedAt.getTime(), now.getTime()]);

  // A functional update: when a rung is clicked as the trail arrives, this effect can run after
  // the click's own update, and must not overwrite the picked rung with the default.
  useEffect(() => {
    if (trail) setEndedAtInput((current) => current || dateInput(proposedEnd.toISOString(), timezone));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trail]);

  const chosenEndedAt = endedAtInput ? new Date(iso(endedAtInput, timezone)) : proposedEnd;
  const deliverable = state.deliverables.find((item) => item.id === session.targetId);
  const title = deliverable?.title ?? session.targetTitle ?? "Deliverable";

  function pickRung(slotAt: string) {
    setEndedAtInput(dateInput(slotAt, timezone));
  }

  function startStopAround() {
    setPhase("tail");
    setDeviationOpen(false);
    setError("");
  }

  async function finishAndAnswer(tailStatus: TailStatus, deviation?: { note?: string }) {
    if (!trail) return;
    const endedAtIso = chosenEndedAt.toISOString();
    setSubmitting(true);
    setError("");
    try {
      await runActivityCommand({
        commandId: createClientId(),
        expectedVersion: session.version ?? null,
        type: "finish_activity",
        sessionId: session.id,
        outcome: "stopped",
        endedAt: endedAtIso
      });
    } catch (reason) {
      setSubmitting(false);
      setError(reason instanceof Error ? reason.message : "The session was not ended.");
      return;
    }
    // Two separate calls, in this order, deliberately not made atomic (design's own risk note): if
    // this second one fails, the session is still correctly ended and the newest unknown check-in
    // just surfaces as an ordinary catch-up prompt afterward.
    try {
      await sendAnswerCheckIns({
        commandId: createClientId(),
        type: "answer_check_ins",
        checkInIds: trail.rows.map((row) => row.id),
        upTo: endedAtIso,
        tail: {
          status: tailStatus,
          ...(deviation?.note?.trim() ? { deviationNote: deviation.note.trim() } : {})
        }
      });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "The session ended, but the check-ins were not all recorded — the newest one will ask again."
      );
    } finally {
      setSubmitting(false);
      setDeviationOpen(false);
    }
  }

  async function workedWholeTime() {
    if (!trail) return;
    setSubmitting(true);
    setError("");
    try {
      await sendAnswerCheckIns({
        commandId: createClientId(),
        type: "answer_check_ins",
        checkInIds: trail.rows.map((row) => row.id),
        upTo: now.toISOString(),
        tail: { status: "on_track" }
      });
      onSettled();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The check-ins were not saved.");
    } finally {
      setSubmitting(false);
    }
  }

  function submitDeviation(event: FormEvent) {
    event.preventDefault();
    void finishAndAnswer("deviated", { note });
  }

  const verifiedLabel =
    verifiedBy === "on_track"
      ? `Last confirmed on track at ${clock(lastVerifiedAt, timezone)}`
      : verifiedBy === "segment"
        ? `Last switched steps at ${clock(segmentStartedAt, timezone)}`
        : `Started at ${clock(segmentStartedAt, timezone)}`;

  return (
    <section className="reconciliation-panel" aria-label="Reconciliation">
      <div className="status-row">
        <p className="eyebrow">Session unverified</p>
        <time>{clock(now, timezone, true)}</time>
      </div>
      <h1>{title}</h1>
      <p className="reason">{verifiedLabel}. The plan asked hourly after that and nobody answered.</p>
      {loadError && (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      )}
      {!trail && !loadError && <p className="reason">Loading the trail…</p>}
      {trail && (
        <ul className="reconciliation-ladder">
          {trail.rows.map((row) => (
            <li key={row.id}>
              <button type="button" className="quiet small" disabled={busy} onClick={() => pickRung(row.slotAt)}>
                {dayClock(row.slotAt, timezone)} — {row.directiveTitle}
              </button>
            </li>
          ))}
        </ul>
      )}
      {phase === "choose" && (
        <>
          <label className="field">
            <span>Proposed end</span>
            <input
              type="datetime-local"
              aria-label="Proposed end"
              value={endedAtInput}
              min={dateInput(new Date(segmentStartedAt.getTime() + 60_000).toISOString(), timezone)}
              max={dateInput(now.toISOString(), timezone)}
              onChange={(event) => setEndedAtInput(event.target.value)}
            />
          </label>
          <div className="actions">
            <button type="button" disabled={busy || !trail} onClick={startStopAround}>
              I stopped around this time
            </button>
            <button type="button" className="quiet" disabled={busy || !trail} onClick={() => void workedWholeTime()}>
              I was working the whole time
            </button>
          </div>
        </>
      )}
      {phase === "tail" && !deviationOpen && (
        <>
          <p className="reason">What were you doing after {clock(chosenEndedAt, timezone)}?</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={() => void finishAndAnswer("on_track")}>
              The thing
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={() => setDeviationOpen(true)}>
              Something else
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={() => void finishAndAnswer("unknown")}>
              Not sure
            </button>
          </div>
        </>
      )}
      {phase === "tail" && deviationOpen && (
        <form className="editor-grid" onSubmit={submitDeviation}>
          <Field label="In your words (optional)">
            <input value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <div className="form-actions">
            <button type="submit" disabled={busy}>
              Save
            </button>
            <button type="button" className="quiet" disabled={busy} onClick={() => setDeviationOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <a
          className="button-link quiet"
          href={`/deliverables?deliverable=${encodeURIComponent(session.targetId ?? "")}`}
        >
          Open workspace
        </a>
      </div>
    </section>
  );
}
