"use client";

import { useState } from "react";
import type { StretchBlock, StretchOfferAnswer } from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { clock } from "@/features/now/now-formatting";
import { StretchRefusedError, type StretchAnswerBody, type StretchDone } from "@/features/now/stretch-client";
import styles from "./stretch-card.module.css";

interface Answered {
  revertible: string;
  outcome: StretchDone["outcome"];
  title: string;
}

/**
 * A stretch on offer: work on something despite the energy cut, for a bounded time. The card describes and asks;
 * yes and no weigh the same (three buttons of one look, nothing preselected, nothing worded as a missed chance).
 * The sentence is the server's (`stretchOfferText`), shown as given. Once answered the card says what stands
 * and offers Undo while this tab still holds the command id; it never nags and has no timer of its own.
 */
export function StretchCard({
  offer,
  stretch,
  timezone,
  answer,
  undo,
  refresh
}: {
  offer: StretchOfferAnswer | null;
  stretch: StretchBlock | null;
  timezone: string;
  answer: (body: StretchAnswerBody) => Promise<StretchDone>;
  undo: (revertible: string) => Promise<unknown>;
  /** Called after a refusal so the stale offer is replaced by what stands now. */
  refresh?: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [answered, setAnswered] = useState<Answered | null>(null);

  async function send(body: StretchAnswerBody, title: string) {
    setBusy(true);
    setError("");
    try {
      const done = await answer(body);
      setAnswered({ revertible: done.revertible, outcome: done.outcome, title });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That answer was not saved. Try again.");
      if (failure instanceof StretchRefusedError) await refresh?.().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (!answered) return;
    setBusy(true);
    setError("");
    try {
      await undo(answered.revertible);
      setAnswered(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The undo was not applied.");
    } finally {
      setBusy(false);
    }
  }

  const active = stretch?.active;
  const showAnswered = !offer && answered && (answered.outcome !== "accepted" || active);
  if (!offer && !active && !stretch?.loan && !showAnswered && !error) return null;

  return (
    <Card as="section" padded aria-label="Stretch" className={styles.card}>
      {offer && (
        <>
          <p className={styles.sentence}>{offer.text}</p>
          {stretch?.today && <p className={styles.note}>{stretch.today.note}</p>}
          <div className={styles.choices}>
            <Button
              disabled={busy}
              wrap
              onClick={() => void send({ choice: "accept", actionId: offer.actionId }, offer.title)}
            >
              Work on it for up to {offer.minutes} minutes
            </Button>
            <Button
              disabled={busy}
              wrap
              onClick={() => void send({ choice: "decline", actionId: offer.actionId }, offer.title)}
            >
              Not this one
            </Button>
            <Button disabled={busy} wrap onClick={() => void send({ choice: "decline_all" }, offer.title)}>
              No stretches tonight
            </Button>
          </div>
        </>
      )}
      {!offer && active && (
        <p className={styles.line}>
          Stretching on {active.title} until {clock(new Date(active.until), timezone)}.
          {answered?.outcome === "accepted" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undoLast()}>
              Undo
            </Button>
          )}
        </p>
      )}
      {!offer && !active && answered && answered.outcome !== "accepted" && (
        <p className={styles.line}>
          {answered.outcome === "declined_all" ? "No stretches tonight." : `Skipped ${answered.title} for today.`}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void undoLast()}>
            Undo
          </Button>
        </p>
      )}
      {!offer && stretch?.today && <p className={styles.note}>{stretch.today.note}</p>}
      {stretch?.loan && <p className={styles.note}>{stretch.loan.line}.</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </Card>
  );
}
