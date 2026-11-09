"use client";

import { isClosedStatus, type CloseEntityResult } from "@openrhen/contracts";
import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { useRef, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import Link from "next/link";
import { outcomePlanHref, projectPlanHref, resolveProjectAreaId } from "@/features/plan/area-grouping";
import { PlanEditorSheets } from "@/features/plan/components/plan-editor-sheets";
import { usePlanEditors } from "@/features/plan/use-plan-editors";
import { useNow } from "@/shared/clock";
import { useMediaQuery } from "@/shared/use-media-query";
import { Sheet } from "@/components/sheet";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cx } from "@/components/ui/cx";
import { List, ListRow } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";
import { PlaceTabs } from "@/components/place-tabs";
import { OverdueProposalsPanel } from "@/features/review/components/overdue-proposals-panel";
import { WeekOutlookPanel } from "@/features/review/components/week-outlook-panel";
import { MonthlyCheckPanel } from "@/features/review/components/monthly-check-panel";
import { AgentTimeLine } from "@/features/review/components/agent-time-line";
import { WatchHistoryPanel } from "@/features/review/components/watch-history-panel";
import { AgentChangesPanel } from "@/features/review/components/agent-changes-panel";
import { ReviewStep, StaleProjects, stepStates, type StaleChoice } from "@/features/review/components/weekly-review";
import { recordInState } from "@/shared/record-in-state";
import { createClientId } from "@/shared/client-id";
import { closeCommandFor, failureText, isChildrenRefusal, undoCommandFor } from "@/features/closed/close-commands";
import { AgentProposalList } from "@/features/agent-proposals/components/agent-proposal-list";
import {
  shownAgentProposals,
  resolveAgentProposalRequest,
  useAgentProposals
} from "@/features/agent-proposals/agent-proposals-store";
import { CheckInTally } from "@/features/check-in/components/check-in-tally";
import { addDays, reviewProgress } from "@/features/review/review-progress";
import { expectedOccurrences } from "@/features/review/expected-occurrences";
import {
  actionStatusCommand,
  keepProjectCommand,
  outcomeReviewCommand,
  overdueSeenCommand,
  projectInternalDeadlineCommand,
  projectStatusCommand,
  saveFocusCommand,
  restoreReviewStampCommand,
  setSeriesEndCommand,
  updateSeriesCommand
} from "@/features/review/review-commands";
import { KEEP_FOR_DAYS } from "@/features/review/stale-projects";
import { useDoctorReport } from "@/features/doctor/doctor-client";
import { attentionCount } from "@/features/doctor/doctor-model";
import { hoursText } from "@/features/plan/components/time-ahead";
import styles from "./review.module.css";

const OPEN_ACTION = (status: string) => !(status === "done" || isClosedStatus(status));
const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * `/review`, Plan's Review tab: the weekly review as three steps, each a card that ticks itself off
 * when it has nothing left. 1, clear blockers: actions blocked or waiting, dates the plan proposes
 * changing, outcome reviews come due, and recurring series that reached their end. 2, wake up stale
 * projects: Keep (saved on the server, and good for 30 days), Pause or Drop each active project with nothing done in a week,
 * except this week's and month's focus projects. Waiting and blocked actions sit in a collapsed group that does not
 * count, and an overdue project can be marked "Seen, leave it" for the review week. 3,
 * choose this week's undated focus, on `/review/focus`. Beside them: the week ahead and the monthly
 * check (each opening its detail in a sheet), what agents are waiting on, and what they changed.
 */
export default function ReviewPage() {
  const {
    state,
    ready,
    capacityEnvelopes,
    forecasts,
    weekOutlook,
    saveActionCommand,
    saveProjectCommand,
    saveEntityCommand,
    confirmProjectWantedCommand,
    closeEntityCommand
  } = usePortal();
  const editors = usePlanEditors();
  const doctor = useDoctorReport();
  const dataToFix = doctor ? attentionCount(doctor) : 0;
  // The shared clock, not `new Date()`: a plain read only reflects wall-clock time as of whichever
  // poll last replaced `state`, which can sit unchanged for a while. Subscribing here — the same
  // hook Today and Now use — re-renders this page every minute so a tab left open keeps catching
  // outcomes and series as they actually come due, not only when other state happens to change.
  const now = useNow("minute");
  const agentProposals = useAgentProposals();
  const phone = useMediaQuery("(max-width: 719px)");
  const timezone = state.settings.timezone;
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [sheet, setSheet] = useState<"week" | "month" | null>(null);
  // How many stale projects were decided this visit, so a phone can count "3 of 8" as it goes.
  const [decided, setDecided] = useState(0);
  // The last Keep, Pause or Drop, so it can be undone: Drop is one tap, like an Inbox ignore. A Keep remembers the
  // stamp it replaced (null when there was none); "Keep all remaining" lists every project it kept.
  const [lastChange, setLastChange] = useState<
    | { choice: "pause"; id: string; title: string; from: (typeof state.projects)[number]["status"] }
    | { choice: "drop"; id: string; title: string; closed: CloseEntityResult }
    | { choice: "keep"; kept: { id: string; title: string; previous: string | null }[] }
    | null
  >(null);
  // A Drop of a project that still has open actions: the server's own sentence, and the choice to close them with it.
  const [dropQuestion, setDropQuestion] = useState<{ projectId: string; message: string } | null>(null);
  // One command id per project dropped, so the "Close all" resend after the refusal replays the same attempt.
  const dropIds = useRef(new Map<string, string>());
  // The last Extend 7 days, so the new end date shows and can be undone.
  const [lastExtend, setLastExtend] = useState<{ id: string; title: string; from: string; to: string } | null>(null);
  // The last "Seen, leave it", so it can be undone back to the stamp it replaced.
  const [lastSeen, setLastSeen] = useState<{ id: string; title: string; previous: string | null } | null>(null);
  const [seriesProblem, setSeriesProblem] = useState("");
  // The last change made in place on a stuck task, a due outcome or an overdue project, so it can be undone.
  const [lastInline, setLastInline] = useState<
    | { kind: "unblock"; id: string; title: string; from: (typeof state.actions)[number]["status"]; wrote: string }
    | {
        kind: "outcome";
        id: string;
        title: string;
        text: string;
        /** The one field the change touched, and what it held before: Undo puts back only that. */
        field: "reviewOn" | "status";
        previous: string | null;
        /** What the change wrote there: if the field holds something else at Undo, it changed elsewhere. */
        wrote: string;
      }
    | {
        kind: "dates";
        text: string;
        items: { id: string; title: string; previous: string | null; wrote: string }[];
      }
    | null
  >(null);
  // Stuck tasks skipped this visit. Nothing is saved: the group never counts, and they list again next visit.
  const [stillWaiting, setStillWaiting] = useState<ReadonlySet<string>>(new Set());
  if (!ready)
    return (
      <main className={`content-page ${styles.page}`}>
        <PageHeader title="Weekly review" answer="Loading the weekly review…" />
        <PlaceTabs />
      </main>
    );

  const dateFormat = dateTimeFormat(displayLocale(), { timeZone: timezone, day: "numeric", month: "short" });
  // A plain `YYYY-MM-DD` end date reads in UTC, so the zone cannot shift it a day.
  const endDateText = (value: string) =>
    dateTimeFormat(displayLocale(), { timeZone: "UTC", day: "numeric", month: "short" }).format(
      new Date(`${value}T00:00:00Z`)
    );
  const {
    today: todayLocal,
    weeklyPeriod,
    monthlyPeriod,
    stuck,
    dueOutcomes,
    endedSeries,
    openForecasts,
    proposals,
    blockers,
    weeklyRecord,
    weeklyIds,
    monthlyIds,
    selected,
    stale,
    lastWeekIds,
    stepsOpen,
    stepsLeft,
    reviewedOn
  } = reviewProgress(state, forecasts, now);
  const available = capacityEnvelopes.reduce((sum, band) => sum + band.adjustedCapacityMinutes, 0);
  const selectedEffort = selected.reduce((sum, id) => {
    const project = state.projects.find((item) => item.id === id);
    return (
      sum +
      (project?.remainingEffortOverrideMinutes ??
        state.actions
          .filter((action) => action.projectId === id && OPEN_ACTION(action.status))
          .reduce((value, action) => value + action.remainingMinutes, 0))
    );
  }, 0);
  const [blockersState, staleState, focusState] = stepStates([...stepsOpen]);
  const reviewAnswer =
    stepsLeft === 0
      ? "This week's review is done."
      : `This week's review has ${stepsLeft === 3 ? "all three steps" : plural(stepsLeft, "step")} left.`;

  const monthName = dateTimeFormat(displayLocale(), { timeZone: "UTC", month: "long" }).format(
    new Date(`${monthlyPeriod.start}T00:00:00Z`)
  );
  const monthDone = state.planningFocus.some(
    (item) => item.kind === "monthly" && item.periodStart === monthlyPeriod.start
  );
  const activeOutcomes = state.outcomes.filter((outcome) => outcome.status === "active").length;
  const week = capacityEnvelopes.find((band) => band.kind === "detailed");
  const shortOnTime = weekOutlook?.underPacedProjectIds.length ?? 0;

  const areaOf = (projectId: string) => {
    const project = state.projects.find((item) => item.id === projectId);
    return project
      ? state.areas.find((area) => area.id === resolveProjectAreaId(project, state.outcomes, state.areas))?.name
      : undefined;
  };
  const openActions = (project: (typeof state.projects)[number]) =>
    state.actions
      .filter((action) => action.projectId === project.id && OPEN_ACTION(action.status))
      .map((action) => action.title);
  const describeStale = (project: (typeof state.projects)[number]) =>
    [
      areaOf(project.id),
      plural(openActions(project).length, "open action"),
      project.lastWorkedAt
        ? `last touched ${dateFormat.format(new Date(project.lastWorkedAt))}`
        : "nothing recorded yet"
    ]
      .filter(Boolean)
      .join(" · ");

  async function choose(project: (typeof state.projects)[number], choice: StaleChoice) {
    setProblem("");
    setLastChange(null);
    setBusy(project.id);
    try {
      if (choice === "keep") {
        const command = keepProjectCommand(project);
        if (!command) throw new Error(`${project.title} has not been saved yet, so it cannot be kept.`);
        await confirmProjectWantedCommand(command);
        setLastChange({
          choice: "keep",
          kept: [{ id: project.id, title: project.title, previous: project.lastReviewedAt ?? null }]
        });
        setDecided((count) => count + 1);
        return;
      }
      if (choice === "drop") return await drop(project, false);
      await saveProjectCommand(projectStatusCommand(project, "paused"));
      setLastChange({ choice: "pause", id: project.id, title: project.title, from: project.status });
      setDecided((count) => count + 1);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : `${project.title} could not be changed.`);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Drop is a cancel, so it goes through the close route like the Cancel button does: stamped as the person, with the
   * server's own checks. A project with open actions asks first (`dropQuestion`) rather than leaving them open under it.
   */
  async function drop(project: (typeof state.projects)[number], includeChildren: boolean) {
    const key = `${project.id}:${project.version ?? ""}`;
    const commandId = dropIds.current.get(key) ?? createClientId();
    dropIds.current.set(key, commandId);
    try {
      const closed = await closeEntityCommand(
        closeCommandFor({ type: "project", id: project.id, version: project.version }, "cancel", {
          commandId,
          includeChildren
        }),
        { handles: (refusal) => isChildrenRefusal(refusal) && !includeChildren }
      );
      dropIds.current.delete(key);
      setDropQuestion(null);
      setLastChange({ choice: "drop", id: project.id, title: project.title, closed });
      setDecided((count) => count + 1);
    } catch (error) {
      if (isChildrenRefusal(error) && !includeChildren)
        return setDropQuestion({ projectId: project.id, message: error.message });
      throw new Error(failureText(error, "close"));
    }
  }

  /** Keeps every stale project still listed, one after another; an Undo puts each earlier stamp back. */
  async function keepAll() {
    setProblem("");
    setLastChange(null);
    setBusy("all");
    const kept: { id: string; title: string; previous: string | null }[] = [];
    try {
      for (const project of stale) {
        const command = keepProjectCommand(project);
        if (!command) throw new Error(`${project.title} has not been saved yet, so it cannot be kept.`);
        await confirmProjectWantedCommand(command);
        kept.push({ id: project.id, title: project.title, previous: project.lastReviewedAt ?? null });
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "Not every project could be kept.");
    } finally {
      if (kept.length > 0) {
        setLastChange({ choice: "keep", kept });
        setDecided((count) => count + kept.length);
      }
      setBusy(null);
    }
  }

  /** Puts the last kept, paused or dropped project (or projects) back as it was, read at its current version. */
  async function undoLast() {
    if (!lastChange) return;
    setProblem("");
    setBusy("undo");
    try {
      if (lastChange.choice === "keep") {
        for (const item of lastChange.kept) {
          const current = state.projects.find((project) => project.id === item.id);
          const command = current && restoreReviewStampCommand(current, item.previous);
          if (command) await confirmProjectWantedCommand(command);
        }
        setDecided((count) => Math.max(0, count - lastChange.kept.length));
        setLastChange(null);
        return;
      }
      if (lastChange.choice === "drop") {
        // The restore is built from the close's result (verb, version, and the children it took), never the tool call.
        const commandId = createClientId();
        await closeEntityCommand(undoCommandFor(lastChange.closed, { commandId }));
        setLastChange(null);
        setDecided((count) => Math.max(0, count - 1));
        return;
      }
      const current = state.projects.find((item) => item.id === lastChange.id);
      if (!current) return setLastChange(null);
      await saveProjectCommand(projectStatusCommand(current, lastChange.from));
      setLastChange(null);
      setDecided((count) => Math.max(0, count - 1));
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "That could not be put back.");
    } finally {
      setBusy(null);
    }
  }

  /** "Seen, leave it": the overdue project stops counting for this review week. Stored on the server. */
  async function markSeen(projectId: string) {
    const project = state.projects.find((item) => item.id === projectId);
    const command = project && overdueSeenCommand(project);
    setSeriesProblem("");
    if (!command) return setSeriesProblem("That project has not been saved yet, so it cannot be marked seen.");
    setLastSeen(null);
    setBusy(projectId);
    try {
      await confirmProjectWantedCommand(command);
      setLastSeen({ id: project.id, title: project.title, previous: project.overdueSeenAt ?? null });
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : "That could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  /** Puts the project's "seen" stamp back, so it counts again. */
  async function undoSeen() {
    if (!lastSeen) return;
    const current = state.projects.find((item) => item.id === lastSeen.id);
    const command = current && restoreReviewStampCommand(current, lastSeen.previous, "overdue_seen");
    if (!command) return setLastSeen(null);
    setSeriesProblem("");
    setBusy(current.id);
    try {
      await confirmProjectWantedCommand(command);
      setLastSeen(null);
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : `${current.title} could not be put back.`);
    } finally {
      setBusy(null);
    }
  }

  async function updateSeries(action: (typeof state.actions)[number], mode: "complete" | "extend") {
    const command = updateSeriesCommand(action, mode, todayLocal);
    if (!command) return;
    setSeriesProblem("");
    setLastExtend(null);
    setBusy(`series:${action.id}`);
    try {
      await saveActionCommand(command);
      if (mode === "extend")
        setLastExtend({
          id: action.id,
          title: action.title,
          from: action.recurrence!.endDate!,
          to: (command.action.recurrence as { endDate: string }).endDate
        });
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : `${action.title} could not be changed.`);
    } finally {
      setBusy(null);
    }
  }

  /** Puts a just-extended series' end date back where it was. */
  async function undoExtend() {
    if (!lastExtend) return;
    const current = state.actions.find((item) => item.id === lastExtend.id);
    const command = current && setSeriesEndCommand(current, lastExtend.from);
    if (!command) return setLastExtend(null);
    setSeriesProblem("");
    setBusy(`series:${current.id}`);
    try {
      await saveActionCommand(command);
      setLastExtend(null);
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : `${current.title} could not be put back.`);
    } finally {
      setBusy(null);
    }
  }

  const announce = [
    lastInline?.kind === "unblock"
      ? `Unblocked ${lastInline.title}.`
      : lastInline?.kind === "outcome"
        ? `${lastInline.title}: ${lastInline.text}`
        : (lastInline?.text ?? ""),
    lastSeen ? `Left ${lastSeen.title} as it is for this week.` : "",
    lastExtend ? `Extended ${lastExtend.title} to ${endDateText(lastExtend.to)}.` : "",
    !lastChange
      ? ""
      : lastChange.choice === "keep"
        ? lastChange.kept.length === 1
          ? `Kept ${lastChange.kept[0]!.title} for ${KEEP_FOR_DAYS} days.`
          : `Kept ${lastChange.kept.length} projects for ${KEEP_FOR_DAYS} days.`
        : `${lastChange.choice === "drop" ? "Dropped" : "Paused"} ${lastChange.title}.`
  ]
    .filter(Boolean)
    .join(" ");

  /** Runs one in-place change from the first step, remembering how to take it back. */
  async function inline(key: string, run: () => Promise<typeof lastInline>) {
    setSeriesProblem("");
    setLastInline(null);
    setBusy(key);
    try {
      setLastInline(await run());
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : "That could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  /** Unblock: a blocked or waiting task goes back to planned. */
  function unblock(action: (typeof state.actions)[number]) {
    return inline(action.id, async () => {
      await saveActionCommand(actionStatusCommand(action, "planned"));
      return { kind: "unblock", id: action.id, title: action.title, from: action.status, wrote: "planned" };
    });
  }

  /** Keep going: the outcome's review moves four weeks on, which also quiets a deadline that has passed. */
  function keepGoing(outcome: (typeof state.outcomes)[number]) {
    const next = addDays(todayLocal, 28);
    return inline(outcome.id, async () => {
      await saveEntityCommand(outcomeReviewCommand(outcome, { reviewOn: next }));
      return {
        kind: "outcome",
        id: outcome.id,
        title: outcome.title,
        text: `Kept going. Next review ${endDateText(next)}.`,
        field: "reviewOn",
        previous: outcome.reviewOn ?? null,
        wrote: next
      };
    });
  }

  /** Close: the outcome is done. */
  function closeOutcome(outcome: (typeof state.outcomes)[number]) {
    return inline(outcome.id, async () => {
      await saveEntityCommand(outcomeReviewCommand(outcome, { status: "done" }));
      return {
        kind: "outcome",
        id: outcome.id,
        title: outcome.title,
        text: "Closed. Its projects leave the plan.",
        field: "status",
        previous: outcome.status,
        wrote: "done"
      };
    });
  }

  /** "Accept <date>" and "Move all": each project's internal date becomes the one its card proposes. */
  function moveDates(moves: { projectId: string; date: Date }[]) {
    return inline("dates", async () => {
      const done: { id: string; title: string; previous: string | null; wrote: string }[] = [];
      try {
        for (const move of moves) {
          const project = state.projects.find((item) => item.id === move.projectId);
          if (!project) continue;
          const wrote = move.date.toISOString();
          await saveProjectCommand(projectInternalDeadlineCommand(project, wrote));
          done.push({ id: project.id, title: project.title, previous: project.internalDeadlineAt ?? null, wrote });
        }
      } catch (error) {
        // Whatever was moved before the failure stays moved, and stays undoable.
        if (done.length > 0) {
          setLastInline({
            kind: "dates",
            text: `Moved ${plural(done.length, "project")} before it stopped.`,
            items: done
          });
          setBusy(null);
        }
        throw error;
      }
      if (done.length === 0) return null;
      const first = moves[0]!;
      return {
        kind: "dates",
        text:
          done.length === 1
            ? `Moved to ${dateFormat.format(first.date)}.`
            : `Moved ${plural(done.length, "project")} to their proposed dates.`,
        items: done
      };
    });
  }

  /** Puts back whatever the last in-place change altered, read at the current version. */
  async function undoInline() {
    if (!lastInline) return;
    setSeriesProblem("");
    setBusy("undo");
    try {
      // Undo puts a field back only while it still holds what the change wrote; otherwise it was changed
      // elsewhere since, and that newer value is left alone.
      const changedElsewhere = (title: string) =>
        setSeriesProblem(`${title} was changed elsewhere since, so Undo left it as it is.`);
      if (lastInline.kind === "unblock") {
        const current = state.actions.find((item) => item.id === lastInline.id);
        if (current && current.status !== lastInline.wrote) changedElsewhere(lastInline.title);
        else if (current) await saveActionCommand(actionStatusCommand(current, lastInline.from));
      } else if (lastInline.kind === "outcome") {
        const current = state.outcomes.find((item) => item.id === lastInline.id);
        const held = current && (lastInline.field === "status" ? current.status : current.reviewOn?.slice(0, 10));
        if (current && held !== lastInline.wrote) changedElsewhere(lastInline.title);
        else if (current)
          await saveEntityCommand(
            outcomeReviewCommand(
              current,
              lastInline.field === "status"
                ? { status: lastInline.previous as (typeof current)["status"] }
                : { reviewOn: lastInline.previous }
            )
          );
      } else {
        for (const item of lastInline.items) {
          const current = state.projects.find((project) => project.id === item.id);
          const held = current?.internalDeadlineAt ? new Date(current.internalDeadlineAt).getTime() : null;
          if (current && held !== new Date(item.wrote).getTime()) changedElsewhere(item.title);
          else if (current) await saveProjectCommand(projectInternalDeadlineCommand(current, item.previous));
        }
      }
      setLastInline(null);
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : "That could not be put back.");
    } finally {
      setBusy(null);
    }
  }

  /** Step 3 in one tap: save this week's focus as last week's, or as none at all. */
  async function saveWeeklyFocus(projectIds: string[]) {
    setSeriesProblem("");
    setBusy("focus");
    try {
      await saveEntityCommand(saveFocusCommand("weekly", weeklyPeriod, weeklyRecord, projectIds));
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : "The focus was not saved.");
    } finally {
      setBusy(null);
    }
  }

  /** Finish the review: this week's focus record keeps today's date as "reviewed on". */
  async function finishReview() {
    setSeriesProblem("");
    setBusy("finish");
    try {
      await saveEntityCommand(
        saveFocusCommand("weekly", weeklyPeriod, weeklyRecord, weeklyRecord?.projectIds ?? [], todayLocal)
      );
    } catch (error) {
      setSeriesProblem(error instanceof Error ? error.message : "The review was not marked finished.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className={`content-page ${styles.page}`}>
      {/* Always mounted, so a screen reader announces the Undo lines when their text arrives. */}
      <div className="visually-hidden" role="status">
        {announce}
      </div>
      <PageHeader
        title="Weekly review"
        answer={reviewAnswer}
        actions={<Link href="/review/closed">Closed items</Link>}
      />
      <PlaceTabs />
      {dataToFix > 0 && (
        <p className={styles.finish}>
          <Link href="/doctor">{plural(dataToFix, "thing")} in your data to fix</Link>
        </p>
      )}
      {reviewedOn ? (
        <p className={styles.finish}>Reviewed on {endDateText(reviewedOn)}.</p>
      ) : stepsLeft === 0 ? (
        <p className={styles.finish}>
          <span>Every step is clear.</span>
          <Button size="sm" disabled={busy !== null} onClick={() => void finishReview()}>
            {busy === "finish" ? "Saving…" : "Finish review"}
          </Button>
        </p>
      ) : null}
      <div className={styles.grid}>
        <div className={styles.steps}>
          <ReviewStep
            number={1}
            state={blockersState!}
            title="Clear blockers"
            summary={
              blockers ? `${plural(blockers, "thing")} to clear before the week can be trusted.` : "Nothing is blocked."
            }
          >
            {seriesProblem && (
              <p className={`form-error ${styles.problem}`} role="alert">
                {seriesProblem}
              </p>
            )}
            {lastInline && (
              <p className={styles.undo}>
                <span>
                  {lastInline.kind === "unblock" ? (
                    <>
                      Unblocked <b>{lastInline.title}</b>.
                    </>
                  ) : lastInline.kind === "outcome" ? (
                    <>
                      <b>{lastInline.title}</b>: {lastInline.text}
                    </>
                  ) : (
                    lastInline.text
                  )}
                </span>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void undoInline()}>
                  Undo
                </Button>
              </p>
            )}
            {lastSeen && (
              <p className={styles.undo}>
                <span>
                  Left <b>{lastSeen.title}</b> as it is for this week.
                </span>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void undoSeen()}>
                  Undo
                </Button>
              </p>
            )}
            {lastExtend && (
              <p className={styles.undo}>
                <span>
                  Extended <b>{lastExtend.title}</b> to {endDateText(lastExtend.to)}.
                </span>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void undoExtend()}>
                  Undo
                </Button>
              </p>
            )}
            {stuck.length > 0 && (
              <details className={styles.waiting}>
                <summary>Waiting on others ({stuck.length})</summary>
                <List>
                  {stuck.map((action) => {
                    const project = state.projects.find((item) => item.id === action.projectId);
                    const checked = stillWaiting.has(action.id);
                    return (
                      <ListRow
                        key={action.id}
                        className={styles.actionRow}
                        title={
                          <Link
                            className={styles.clamp}
                            href={project ? projectPlanHref(project, state.outcomes, state.areas) : "/plan"}
                          >
                            {action.title}
                          </Link>
                        }
                        meta={`${action.status === "blocked" ? "Blocked" : "Waiting on something"}${project ? ` · ${project.title}` : ""}${checked ? " · skipped for now, not saved" : ""}`}
                        trailing={
                          <>
                            <Button size="sm" disabled={busy !== null} onClick={() => void unblock(action)}>
                              Unblock
                            </Button>
                            {!checked && (
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() => setStillWaiting((set) => new Set(set).add(action.id))}
                              >
                                Skip for now
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy !== null}
                              onClick={() => editors.openEdit("action", action)}
                            >
                              Edit
                            </Button>
                          </>
                        }
                      />
                    );
                  })}
                </List>
              </details>
            )}
            {blockers > 0 && (
              <>
                {dueOutcomes.length > 0 && (
                  <section aria-labelledby="review-outcomes" className={styles.group}>
                    <h4 id="review-outcomes" className={styles.groupTitle}>
                      Outcome reviews and deadlines <Badge dot={false}>{dueOutcomes.length}</Badge>
                    </h4>
                    <List>
                      {dueOutcomes.map((item) => (
                        <ListRow
                          key={item.id}
                          className={styles.actionRow}
                          title={<Link href={outcomePlanHref(item, state.areas)}>{item.title}</Link>}
                          meta={item.reviewOn ? `Review due ${item.reviewOn}` : "Deadline has passed"}
                          trailing={
                            <>
                              <Button size="sm" disabled={busy !== null} onClick={() => void keepGoing(item)}>
                                Keep going
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() => void closeOutcome(item)}
                              >
                                Close outcome
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy !== null}
                                onClick={() => editors.openEdit("outcome", item)}
                              >
                                Edit
                              </Button>
                            </>
                          }
                        />
                      ))}
                    </List>
                  </section>
                )}
                {endedSeries.length > 0 && (
                  <section aria-labelledby="review-series" className={styles.group}>
                    <h4 id="review-series" className={styles.groupTitle}>
                      Recurring series ready <Badge dot={false}>{endedSeries.length}</Badge>
                    </h4>
                    <List>
                      {endedSeries.map((action) => {
                        const evidence = state.occurrences.filter((item) => item.actionId === action.id);
                        const completed = evidence.filter((item) => item.status === "completed").length;
                        const missed = evidence.filter((item) => item.status === "missed").length;
                        const expected = expectedOccurrences(action.recurrence!, now, timezone);
                        return (
                          <ListRow
                            key={action.id}
                            title={action.title}
                            meta={`${expected} expected · ${completed} done · ${missed} missed · ${Math.max(0, expected - completed - missed)} not recorded`}
                            trailing={
                              <>
                                <Button
                                  size="sm"
                                  disabled={busy !== null}
                                  onClick={() => void updateSeries(action, "complete")}
                                >
                                  Complete
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={busy !== null}
                                  onClick={() => void updateSeries(action, "extend")}
                                >
                                  {busy === `series:${action.id}` ? "Saving…" : "Extend 7 days"}
                                </Button>
                              </>
                            }
                          />
                        );
                      })}
                    </List>
                  </section>
                )}
                {proposals > 0 && (
                  <div className={styles.group}>
                    <OverdueProposalsPanel
                      forecasts={openForecasts}
                      state={state}
                      onSeen={(projectId) => void markSeen(projectId)}
                      onAccept={(projectId, date) => void moveDates([{ projectId, date }])}
                      onMoveAll={(moves) => void moveDates(moves)}
                      onEdit={(projectId) => {
                        const project = state.projects.find((item) => item.id === projectId);
                        if (project) editors.openEdit("project", project);
                      }}
                      busy={busy !== null}
                    />
                  </div>
                )}
              </>
            )}
          </ReviewStep>

          <ReviewStep
            number={2}
            state={staleState!}
            title="Wake up stale projects"
            summary={
              stale.length
                ? `${plural(stale.length, "project")} with nothing done in a week. Keep, pause or drop each one.`
                : "Every active project moved this week."
            }
            count={
              stale.length
                ? phone
                  ? `${decided + 1} of ${stale.length + decided}`
                  : `${stale.length} left`
                : undefined
            }
          >
            {problem && (
              <p className={`form-error ${styles.problem}`} role="alert">
                {problem}
              </p>
            )}
            {dropQuestion && (
              <div className={styles.undo} role="group" aria-label="Close the open actions with it?">
                <span>{dropQuestion.message}</span>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy !== null}
                  onClick={() => {
                    const project = state.projects.find((item) => item.id === dropQuestion.projectId);
                    if (!project) return setDropQuestion(null);
                    setBusy(project.id);
                    setProblem("");
                    drop(project, true)
                      .catch((error: unknown) =>
                        setProblem(error instanceof Error ? error.message : `${project.title} could not be changed.`)
                      )
                      .finally(() => setBusy(null));
                  }}
                >
                  Close all
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setDropQuestion(null)}>
                  Keep open
                </Button>
              </div>
            )}
            {lastChange && (
              <p className={styles.undo}>
                <span>
                  {lastChange.choice === "keep" ? (
                    lastChange.kept.length === 1 ? (
                      <>
                        Kept <b>{lastChange.kept[0]!.title}</b> for {KEEP_FOR_DAYS} days.
                      </>
                    ) : (
                      <>
                        Kept <b>{lastChange.kept.length} projects</b> for {KEEP_FOR_DAYS} days.
                      </>
                    )
                  ) : (
                    <>
                      {lastChange.choice === "drop" ? "Dropped" : "Paused"} <b>{lastChange.title}</b>.
                    </>
                  )}
                </span>
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void undoLast()}>
                  Undo
                </Button>
              </p>
            )}
            {stale.length > 0 && (
              <>
                <StaleProjects
                  projects={stale}
                  hrefOf={(project) => projectPlanHref(project, state.outcomes, state.areas)}
                  describe={describeStale}
                  openActions={openActions}
                  onChoose={(project, choice) => void choose(project, choice)}
                  busy={busy}
                  oneAtATime={phone}
                />
                {stale.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={styles.keepAll}
                    disabled={busy !== null}
                    onClick={() => void keepAll()}
                  >
                    Keep all remaining ({stale.length})
                  </Button>
                )}
              </>
            )}
          </ReviewStep>

          <ReviewStep
            number={3}
            state={focusState!}
            title="Choose this week's undated focus"
            summary={
              <>
                Projects without a deadline only get time when you pick them.{" "}
                <span className={selectedEffort > available ? styles.over : undefined}>
                  {weeklyIds.length} selected this week · {monthlyIds.length} selected this month, ~
                  {Math.round(selectedEffort / 60)} h of {Math.round(available / 60)} h available
                </span>
              </>
            }
            count={
              <ButtonLink href="/review/focus" size="sm">
                {weeklyIds.length ? "Edit focus" : "Choose focus"}
              </ButtonLink>
            }
          >
            {focusState !== "done" && (
              <div className={styles.focusActions}>
                {lastWeekIds.length > 0 && (
                  <Button size="sm" disabled={busy !== null} onClick={() => void saveWeeklyFocus(lastWeekIds)}>
                    Keep last week&apos;s focus ({lastWeekIds.length})
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void saveWeeklyFocus([])}>
                  No focus this week
                </Button>
              </div>
            )}
          </ReviewStep>
        </div>

        <aside className={styles.side} aria-label="Around the review">
          <Card as="section" padded className={styles.sideCard} aria-labelledby="review-week">
            <h2 id="review-week" className={styles.sideTitle}>
              Week ahead
              {weekOutlook
                ? ` · ${dateFormat.format(weekOutlook.startsAt)} to ${dateFormat.format(weekOutlook.endsAt)}`
                : ""}
            </h2>
            <p className={styles.sideText}>
              {weekOutlook
                ? `${plural(weekOutlook.projects.length, "project")} with time set aside${week ? `, ${hoursText(week.freeMinutes)} free` : ""}. ${shortOnTime ? `${plural(shortOnTime, "project is", "projects are")} short on time.` : "The plan fits."}`
                : "The current plan was made before a week outlook was available."}
            </p>
            {weekOutlook && (
              <button type="button" className={styles.sideLink} onClick={() => setSheet("week")}>
                Open the week
              </button>
            )}
          </Card>

          <Card as="section" padded className={styles.sideCard} aria-labelledby="review-month">
            <div className={styles.sideHead}>
              <h2 id="review-month" className={styles.sideTitle}>
                Monthly check · {monthName}
              </h2>
              {!monthDone && <Badge tone="warn">Due</Badge>}
            </div>
            <p className={styles.sideText}>
              {monthDone
                ? `${monthName}'s focus is chosen.`
                : `${plural(activeOutcomes, "active outcome")} to re-judge, and where your time went. Takes about 5 minutes.`}
            </p>
            <Button size="sm" className={styles.sideStart} onClick={() => setSheet("month")}>
              {monthDone ? "Open monthly check" : "Start monthly check"}
            </Button>
          </Card>

          {/* What agents are waiting on sits beside what they changed, as well as in Inbox > Captured. */}
          {/* The two agent lists are shared with the Inbox, which restyles them itself; here they sit in
              side cards, so their headings and rows are scaled down to the column. */}
          {shownAgentProposals(agentProposals).length > 0 && (
            <Card as="div" padded className={cx(styles.sideCard, styles.agents)}>
              <AgentProposalList
                proposals={shownAgentProposals(agentProposals)}
                onResolve={resolveAgentProposalRequest}
                findRecord={(kind, id, sent) => recordInState(state, kind, id, sent)}
                timezone={timezone}
              />
            </Card>
          )}
          <Card as="div" padded className={cx(styles.sideCard, styles.agents)}>
            <AgentChangesPanel timezone={timezone} />
            <AgentTimeLine />
          </Card>
          <Card as="div" padded className={styles.sideCard}>
            <WatchHistoryPanel />
          </Card>
          <div className={styles.tally}>
            <CheckInTally />
          </div>
        </aside>
      </div>

      <PlanEditorSheets
        editors={editors}
        areas={state.areas}
        outcomes={state.outcomes}
        projects={state.projects}
        actions={state.actions}
        deliverables={state.deliverables}
        conditionDefinitions={state.conditionDefinitions}
        estimateBucketsMinutes={state.settings.estimateBucketsMinutes}
        timezone={state.settings.timezone}
      />
      <Sheet open={sheet === "week"} onClose={() => setSheet(null)} title="Week ahead">
        <WeekOutlookPanel outlook={weekOutlook} state={state} folded={false} />
      </Sheet>
      <Sheet open={sheet === "month"} onClose={() => setSheet(null)} title={`Monthly check · ${monthName}`}>
        <MonthlyCheckPanel state={state} now={now} folded={false} />
      </Sheet>
    </main>
  );
}
