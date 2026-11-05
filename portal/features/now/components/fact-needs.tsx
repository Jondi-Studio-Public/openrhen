"use client";

import { useState } from "react";
import { endsAtPause, type Need } from "@openrhen/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Count } from "@/components/ui/count";
import { situationCommand } from "@/components/situation-panel";
import type { ActiveSession, PortalState } from "@/state/portal-state";
import { finishActivityCommand } from "@/features/deliverables/deliverable-commands";
import { energyLabel } from "@/features/settings/settings-format";
import { dateInput, dateOnly, iso, nextDayKey } from "@/features/today/local-datetime";
import { wallClock } from "@/features/now/now-formatting";
import type { FinishSession, RunActivityCommand, SaveEntityCommand } from "@/features/now/now-model";
import { wakeCommand } from "@/features/now/need-commands";
import { usePressGuard } from "@/shared/use-press-guard";
import { energyCommand } from "./availability-panel";
import styles from "../now-page.module.css";

const ENERGIES = ["high", "medium", "low", "recovery"] as const;

type SessionOutcome = "finished" | "progress" | "unsure";
/**
 * The most recent moment the preferred wake time struck, no later than now: today's, or yesterday's
 * while today's has not come yet. The server refuses a wake in the future, so the one tap never offers one.
 * Yesterday is the calendar day before, not 24 hours back, which a 23-hour daylight-saving day would carry
 * two days back.
 */
export function latestPreferredWake(
  preferredWakeTime: string,
  timezone: string,
  now: Date
): { at: string; yesterday: boolean } | undefined {
  // A setting that is not a clock time offers nothing rather than failing the page.
  if (!/^\d{2}:\d{2}$/.test(preferredWakeTime)) return undefined;
  const day = dateOnly(now, timezone);
  const today = iso(`${day}T${preferredWakeTime}`, timezone);
  if (new Date(today).getTime() <= now.getTime()) return { at: today, yesterday: false };
  return { at: iso(`${nextDayKey(day, -1)}T${preferredWakeTime}`, timezone), yesterday: true };
}

interface Ctx {
  state: PortalState;
  session: ActiveSession | null;
  now: Date;
  timezone: string;
  saving: boolean;
  saveEntityCommand: SaveEntityCommand;
  finishSession: FinishSession;
  runActivityCommand: RunActivityCommand;
}

function reasonText(reason: unknown): string {
  return reason instanceof Error ? reason.message : "That was not saved. Try again.";
}

/** A time the person can set, held in its own state so typing never re-asks the plan anything. */
function useTimeField(initial: string) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  /** Runs a save and says here why it was refused (a time before the start, say) rather than behind the page. */
  async function attempt(run: () => Promise<void> | void) {
    setError("");
    try {
      await run();
    } catch (reason) {
      setError(reasonText(reason));
    }
  }
  return { value, setValue, error, attempt };
}

function WakeAnswer({ state, now, timezone, saveEntityCommand }: Ctx) {
  const field = useTimeField("");
  const { press, isPending } = usePressGuard();
  const preferred = latestPreferredWake(state.settings.preferredWakeTime, timezone, now);
  // Never a step back: the old wake is the stale one, and a preferred time before it says nothing new.
  const lastWokeAt = state.settings.lastWokeAt;
  const offerPreferred =
    preferred !== undefined && (!lastWokeAt || new Date(preferred.at).getTime() > new Date(lastWokeAt).getTime());
  const save = (at: string) => void press("wake", () => field.attempt(() => saveEntityCommand(wakeCommand(state, at))));
  return (
    <>
      {preferred && offerPreferred ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={isPending("wake")}
          aria-busy={isPending("wake") || undefined}
          onClick={() => save(preferred.at)}
        >
          Woke at {wallClock(state.settings.preferredWakeTime)}
          {preferred.yesterday ? " yesterday" : ""}
        </Button>
      ) : null}
      <input
        type="datetime-local"
        className={styles.needField}
        aria-label="When you woke"
        value={field.value}
        max={dateInput(now.toISOString(), timezone)}
        onChange={(event) => field.setValue(event.target.value)}
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={isPending("wake") || field.value === ""}
        onClick={() => save(iso(field.value, timezone))}
      >
        Woke then
      </Button>
      {field.error ? (
        <p className={styles.needError} role="alert">
          {field.error}
        </p>
      ) : null}
    </>
  );
}

function SessionEndAnswer({
  need,
  session,
  now,
  timezone,
  saving,
  finishSession,
  runActivityCommand
}: Ctx & {
  need: Need;
  session: ActiveSession;
}) {
  // Paused (or paused and then left awaiting feedback), the end is the pause already recorded: the server
  // refuses a later time, so the need asks for none (its answer has no `endedAt`). Otherwise the field starts
  // at the planned end, which is when the work is taken to have stopped unless the person says so.
  const paused = endsAtPause(session);
  const asksTime = !paused && need.answer.fields.includes("endedAt");
  const field = useTimeField(asksTime ? dateInput(need.asOf, timezone) : "");
  const targetType = session.targetType ?? "action";
  // Stopping an action is not finishing it: neither "When did it stop?" nor "Finish it?" may mark the work
  // done by itself, so nothing is chosen until the person says how it went, as on the checkpoint sheet.
  // Other targets have the one outcome they end with.
  const [outcome, setOutcome] = useState<SessionOutcome | "">("");
  const [minutesLeft, setMinutesLeft] = useState(String(Math.max(1, session.remainingBeforeMinutes)));
  const chooses = targetType === "action";
  const minutes = Number(minutesLeft);
  const progressInvalid = chooses && outcome === "progress" && !(Number.isInteger(minutes) && minutes >= 1);
  const undecided = chooses && outcome === "";
  const finish = () => {
    const endedAt = asksTime && field.value ? iso(field.value, timezone) : undefined;
    const details = endedAt ? { endedAt } : undefined;
    void field.attempt(() => {
      if (targetType === "action") {
        if (!chooses || outcome === "finished") return finishSession("finished", 0, details);
        return outcome === "progress"
          ? finishSession("progress", minutes, details)
          : finishSession("unsure", undefined, details);
      }
      // A deliverable's session ends as stopped, never completed: the deliverable is not done by it.
      return runActivityCommand(
        finishActivityCommand(session, targetType === "deliverable" ? "stopped" : "completed", undefined, endedAt)
      );
    });
  };
  return (
    <>
      {asksTime ? (
        <input
          type="datetime-local"
          className={styles.needField}
          aria-label="It stopped at"
          value={field.value}
          min={dateInput(session.startedAt, timezone)}
          max={dateInput(now.toISOString(), timezone)}
          onChange={(event) => field.setValue(event.target.value)}
        />
      ) : null}
      {chooses ? (
        <select
          className={styles.needField}
          aria-label="How it went"
          value={outcome}
          onChange={(event) => setOutcome(event.target.value as SessionOutcome)}
        >
          <option value="" disabled>
            How did it go?
          </option>
          <option value="finished">Finished it</option>
          <option value="progress">Made progress</option>
          <option value="unsure">Not sure</option>
        </select>
      ) : null}
      {chooses && outcome === "progress" ? (
        <input
          type="number"
          min="1"
          inputMode="numeric"
          className={styles.needField}
          aria-label="Minutes left"
          value={minutesLeft}
          onChange={(event) => setMinutesLeft(event.target.value)}
        />
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        disabled={saving || (asksTime && field.value === "") || undecided || progressInvalid}
        onClick={finish}
      >
        {asksTime ? "It stopped then" : "Finish"}
      </Button>
      {field.error ? (
        <p className={styles.needError} role="alert">
          {field.error}
        </p>
      ) : null}
    </>
  );
}

function NeedAnswer({ need, ctx }: { need: Need; ctx: Ctx }) {
  const { state, saving, saveEntityCommand } = ctx;
  switch (need.fact) {
    case "location": {
      const locationId = need.subjectId;
      return locationId ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={saving}
          onClick={() => void saveEntityCommand(situationCommand(state, { locationId }))}
        >
          Still at {need.title}
        </Button>
      ) : null;
    }
    case "energy":
      return (
        <div className={styles.needChoices} role="group" aria-label="Energy now">
          {ENERGIES.map((energy) => (
            <Button
              key={energy}
              size="sm"
              variant="secondary"
              disabled={saving}
              onClick={() => void saveEntityCommand(energyCommand(state, energy))}
            >
              {energyLabel(energy)}
            </Button>
          ))}
        </div>
      );
    case "wake":
      return <WakeAnswer {...ctx} />;
    case "session_end":
      return ctx.session && need.subjectId === ctx.session.id ? (
        <SessionEndAnswer {...ctx} need={need} session={ctx.session} />
      ) : null;
    default:
      // A fact with no tap here (a date, an effort) is still said, in the words every surface uses.
      return null;
  }
}

/**
 * What OpenRhen needs to be told because something it was told has aged out
 * one line per need, with the one-tap answer where
 * there is one. Every answer reuses a write Now already makes: the situation command for a place, the
 * availability panel's energy command, the settings save for a wake, and the session finish for a
 * session left open. Blocking needs stand above the directive with no heading; the rest sit under
 * "Also check".
 */
export function FactNeeds({
  needs,
  heading,
  label,
  state,
  session,
  now,
  timezone,
  saving,
  saveEntityCommand,
  finishSession,
  runActivityCommand
}: Ctx & {
  needs: readonly Need[];
  /** The visible heading; absent for the blocking stack, which is named only for assistive technology. */
  heading?: string | undefined;
  label: string;
}) {
  if (needs.length === 0) return null;
  const ctx: Ctx = { state, session, now, timezone, saving, saveEntityCommand, finishSession, runActivityCommand };
  return (
    <Card as="section" aria-label={label} className={styles.needs} data-blocking={heading === undefined}>
      {heading ? <CardHeader title={heading} trailing={<Count value={needs.length} />} /> : null}
      <ul className={styles.needList}>
        {needs.map((need) => (
          <li key={`${need.fact}:${need.subjectId ?? ""}`} className={styles.need} data-fact={need.fact}>
            <div className={styles.needText}>
              {need.fact === "session_end" ? <p className={styles.needTitle}>{need.title}</p> : null}
              <p className={styles.needQuestion}>{need.question}</p>
            </div>
            <div className={styles.needControls}>
              <NeedAnswer need={need} ctx={ctx} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
