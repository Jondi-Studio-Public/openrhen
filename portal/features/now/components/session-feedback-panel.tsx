"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { BlockingReason } from "@openrhen/contracts";
import type { PortalState, StoredAction } from "@/state/portal-state";
import { Sheet } from "@/components/sheet";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { ListRow } from "@/components/ui/list-row";
import { cx } from "@/components/ui/cx";
import { clock, dayClock, hoursMinutes, projectTitle } from "@/features/now/now-formatting";
import { dateInput, iso } from "@/features/today/local-datetime";
import type { FinishSession, NowContinuation } from "@/features/now/now-model";
import { BLOCKING_REASONS } from "./blocking-reasons";
import styles from "../now-page.module.css";

type Answer = "finished" | "progress" | "continue" | "blocked" | "did_not_start";

const REMAINING_CHOICES: { value: string; label: string }[] = [
  { value: "15", label: "15 min" },
  { value: "30", label: "30 min" },
  { value: "60", label: "1 h" },
  { value: "custom", label: "More…" },
  { value: "unsure", label: "Not sure" }
];

/**
 * "Keep 180 min": the task's own estimate, offered first and chosen by default so Made progress does not
 * quietly replace a three-hour estimate with 30 minutes. It saves as ordinary progress, not as "Not sure",
 * so it does not flag the estimate for review. Absent when the task has no minutes left to keep.
 */
export const KEEP_CHOICE = "keep";

/**
 * The checkpoint question, as a sheet of four answers over the session's hero. Every answer is what the
 * engine learns from the session, so the sheet offers each ending (finished, progress, stuck, never
 * started, and keep going when that is safe) and nothing else. The chosen answer opens its one
 * follow-up in place, and Save sends it. Closing the sheet leaves "How did it go?" on the hero.
 */
export function SessionFeedbackPanel({
  sessionAction,
  state,
  now,
  timezone,
  saving,
  plannedStart,
  plannedDuration,
  planningDecisionCurrent,
  continuation,
  remainingChoice,
  onRemainingChoiceChange,
  customRemaining,
  onCustomRemainingChange,
  blockReason,
  onBlockReasonChange,
  note,
  onNoteChange,
  finishSession
}: {
  sessionAction: StoredAction;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  plannedStart: Date;
  plannedEnd: Date;
  plannedDuration: number;
  planningDecisionCurrent: boolean;
  continuation: NowContinuation;
  remainingChoice: string;
  onRemainingChoiceChange: (value: string) => void;
  customRemaining: number;
  onCustomRemainingChange: (value: number) => void;
  blockReason: BlockingReason;
  onBlockReasonChange: (reason: BlockingReason) => void;
  note: string;
  onNoteChange: (value: string) => void;
  finishSession: FinishSession;
}) {
  const [open, setOpen] = useState(true);
  const keepMinutes = sessionAction.remainingMinutes > 0 ? sessionAction.remainingMinutes : null;
  const remaining = remainingChoice === KEEP_CHOICE && keepMinutes === null ? "30" : remainingChoice;
  const remainingChoices = [
    ...(keepMinutes === null ? [] : [{ value: KEEP_CHOICE, label: `Keep ${keepMinutes} min` }]),
    ...REMAINING_CHOICES.filter((choice) => choice.value !== String(keepMinutes))
  ];
  // Each checkpoint starts from the estimate, not from whatever the last session ended on.
  const resetChoice = useRef(onRemainingChoiceChange);
  useEffect(() => {
    resetChoice.current(KEEP_CHOICE);
  }, []);
  const reopen = useRef<HTMLButtonElement>(null);
  // The sheet opens by itself, so it has no opener to hand focus back to: closing it (Escape, the
  // backdrop, a swipe) lands focus on the button that brings it back rather than on the page's start.
  // This runs after the sheet's own focus restore, so it wins.
  useEffect(() => {
    if (!open) reopen.current?.focus();
  }, [open]);
  const [picked, setPicked] = useState<Answer | null>(null);
  const [error, setError] = useState("");
  const [noteOpen, setNoteOpen] = useState(note !== "");
  // The field holds what is typed and is only tidied on blur: clamping each keystroke turned a typed
  // "9" into the minimum before the second digit could land. The parent still gets a valid whole
  // number on every change, so Made progress never sends a half-typed value.
  const [customText, setCustomText] = useState<string | null>(null);
  // When the work really stopped, if that was not when the clock did (the page was closed past the
  // checkpoint). Blank keeps the clock's own stop. Only Finished it and Made progress can carry it.
  const [endedAtInput, setEndedAtInput] = useState("");
  const endedAt = endedAtInput ? { endedAt: iso(endedAtInput, timezone) } : {};
  const area = projectTitle(state, sessionAction.projectId);
  const minutesIn = Math.max(0, Math.round((now.getTime() - plannedStart.getTime()) / 60_000));
  // A session past a day old was left running rather than worked: say so instead of "1357 min in".
  const started =
    minutesIn >= 24 * 60
      ? `started ${dayClock(plannedStart.toISOString(), timezone)} and left running`
      : `started ${clock(plannedStart, timezone)}, ${minutesIn < 60 ? `${minutesIn} min` : hoursMinutes(minutesIn)} in`;
  const canContinue = planningDecisionCurrent && Boolean(continuation?.safe);
  // Keep going chosen while it was safe stops being an answer the moment it is not (the plan went
  // stale, or a new continuation said no): its row is gone, so Save must not still send it.
  const answer = picked === "continue" && !canContinue ? null : picked;
  const continueRefusal = !planningDecisionCurrent
    ? "Keeping going comes back once the plan refreshes."
    : continuation && !continuation.safe
      ? continuation.reason
      : null;

  const remainingMinutes =
    remaining === "unsure"
      ? undefined
      : remaining === "custom"
        ? customRemaining
        : remaining === KEEP_CHOICE
          ? (keepMinutes ?? 30)
          : Number(remaining);

  function save() {
    const sent = send();
    if (!sent) return;
    setError("");
    // The sheet stays open while it saves, so a refusal is said here rather than behind the backdrop.
    sent.catch((reason: unknown) =>
      setError(reason instanceof Error ? reason.message : "That answer was not saved. Try again.")
    );
  }

  function send() {
    switch (answer) {
      case "finished":
        return finishSession("finished", 0, { note, ...endedAt });
      case "progress":
        return finishSession(remaining === "unsure" ? "unsure" : "progress", remainingMinutes, {
          note,
          ...endedAt
        });
      case "continue":
        return finishSession("continue");
      case "blocked":
        return finishSession("blocked", sessionAction.remainingMinutes, {
          reason: blockReason,
          actionStatus: blockReason === "waiting_on_someone" ? "waiting" : "blocked",
          note
        });
      case "did_not_start":
        return finishSession("did_not_start", sessionAction.remainingMinutes, { note });
      default:
        return undefined;
    }
  }

  const saveLabel =
    answer === "progress" && remainingMinutes !== undefined
      ? `Save · ${remainingMinutes} min left`
      : answer === "continue" && continuation
        ? `Keep going ${continuation.recommendedMinutes} min`
        : "Save";

  // Shown under Finished it and Made progress, the two answers that can say when work really stopped.
  const endedField = (
    <label className={styles.field}>
      <span>It ended at (optional)</span>
      <input
        type="datetime-local"
        aria-label="It ended at"
        value={endedAtInput}
        min={dateInput(plannedStart.toISOString(), timezone)}
        max={dateInput(now.toISOString(), timezone)}
        onChange={(event) => setEndedAtInput(event.target.value)}
      />
      <small className={styles.caption}>Blank keeps the time the clock stopped.</small>
    </label>
  );

  // A plain function rather than a component: declared inside, a component would be a new type on every
  // render and remount the minutes field under the cursor.
  function row(value: Answer, title: string, meta: string, children?: ReactNode) {
    const chosen = answer === value;
    return (
      <div key={value} className={styles.answer} data-chosen={chosen}>
        <ListRow
          leading={<span className={styles.radio} aria-hidden="true" />}
          title={title}
          meta={meta}
          pressed={chosen}
          onClick={() => setPicked(value)}
        />
        {chosen && children ? <div className={styles.follow}>{children}</div> : null}
      </div>
    );
  }

  return (
    <>
      <p className={styles.kicker}>
        <span className={styles.ring} aria-hidden="true" />
        Checkpoint · {plannedDuration} min planned
      </p>
      <div className={styles.heading}>
        <h1>{sessionAction.title}</h1>
        {area ? <p className={styles.lead}>{area}</p> : null}
      </div>
      <div className={cx("actions", styles.actions)}>
        <Button
          variant="primary"
          size="lg"
          className={styles.start}
          aria-haspopup="dialog"
          ref={reopen}
          onClick={() => setOpen(true)}
        >
          How did it go?
        </Button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title="How did it go?">
        <div className={styles.sheetBody}>
          <p className={styles.sheetSub}>
            {sessionAction.title} · {started}
          </p>
          <Card className={styles.answers}>
            {row(
              "finished",
              sessionAction.schedulingMode === "cadence" ? "Done for today" : "Finished it",
              "Marks it done and moves on",
              endedField
            )}
            {row(
              "progress",
              "Made progress",
              "How much is left?",
              <>
                <div className={styles.chips} role="group" aria-label="How much is left?">
                  {remainingChoices.map((choice) => (
                    <Chip
                      key={choice.value}
                      pressed={remaining === choice.value}
                      onClick={() => onRemainingChoiceChange(choice.value)}
                    >
                      {choice.label}
                    </Chip>
                  ))}
                </div>
                {remaining === "custom" && (
                  <label className={styles.field}>
                    <span>Exact remaining minutes</span>
                    <input
                      type="number"
                      min="1"
                      inputMode="numeric"
                      value={customText ?? customRemaining}
                      onChange={(event) => {
                        setCustomText(event.target.value);
                        // An empty or invalid field leaves the parent's last valid value alone.
                        const typed = Math.round(Number(event.target.value));
                        if (event.target.value.trim() !== "" && typed >= 1) onCustomRemainingChange(typed);
                      }}
                      onBlur={() => setCustomText(null)}
                    />
                  </label>
                )}
                <p className={styles.caption}>The rest goes back on the plan.</p>
                {endedField}
              </>
            )}
            {canContinue && continuation
              ? row(
                  "continue",
                  `Keep going for ${continuation.recommendedMinutes} min`,
                  "Fits without squeezing anything due sooner"
                )
              : null}
            {!canContinue && continueRefusal ? (
              <p className={styles.refusal}>Keep going isn&apos;t offered: {continueRefusal}</p>
            ) : null}
            {row(
              "blocked",
              "Got stuck",
              "Say what's blocking it",
              <div className={styles.chips} role="group" aria-label="What's blocking it?">
                {BLOCKING_REASONS.map((reason) => (
                  <Chip
                    key={reason.value}
                    pressed={blockReason === reason.value}
                    onClick={() => onBlockReasonChange(reason.value)}
                  >
                    {reason.label}
                  </Chip>
                ))}
              </div>
            )}
            {row("did_not_start", "Didn't start", "Back on the list, no questions")}
          </Card>
          {noteOpen ? (
            <label className={styles.field}>
              <span>Note</span>
              <input value={note} onChange={(event) => onNoteChange(event.target.value)} autoFocus />
            </label>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.sheetActions}>
            <Button variant="ghost" onClick={() => setNoteOpen((current) => !current)}>
              {noteOpen ? "Hide note" : "Add a note"}
            </Button>
            <Button variant="primary" disabled={saving || answer === null} onClick={save}>
              {saveLabel}
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
