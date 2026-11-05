"use client";

import { useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { cx } from "@/components/ui/cx";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Meter } from "@/components/ui/stat";
import type { BlockingReason, OverrideReason, PrepPace, StartByWarning } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { ActionBar } from "@/components/action-bar";
import { ReportIssue } from "@/components/report-issue";
import { situationCommand, type LocationPromptView } from "@/components/situation-panel";
import type { ActiveSession, PortalState, StoredCommitment } from "@/state/portal-state";
import { useNow } from "@/shared/clock";
import { openCaptureSheet } from "@/shared/use-capture-sheet";
import { dismissPendingLocationSuggestion, useLocationObservation } from "@/shared/use-location-observation";
import { activeDisruption } from "@/features/disruptions/disruption-summary";
import { RenegotiationPanel } from "@/features/disruptions/components/renegotiation-panel";
import { CheckInBanner } from "@/features/check-in/components/check-in-banner";
import { extensionBanners } from "@/state/extensions";
import { clock, hoursMinutes, localDate, projectTitle } from "@/features/now/now-formatting";
import {
  buildNowModel,
  planStatusChip,
  recommendedActionFinished,
  visibleNeeds,
  type NeedsHero,
  type NowProtectedCommitment,
  type SaveEntityCommand
} from "@/features/now/now-model";
import { buildNowViewBase } from "@/features/now/now-report-view";
import { ActionSessionPanel } from "@/features/now/components/action-session-panel";
import { ActivitySessionPanel } from "@/features/now/components/activity-session-panel";
import { AnswerPanel } from "@/features/now/components/answer-panel";
import { AvailabilityPanel } from "@/features/now/components/availability-panel";
import { BoundaryPanel } from "@/features/now/components/boundary-panel";
import { DeliverableSessionPanel } from "@/features/now/components/deliverable-session-panel";
import { EngagementStrip } from "@/features/now/components/engagement-strip";
import { FactNeeds } from "@/features/now/components/fact-needs";
import { StretchSection } from "@/features/now/components/stretch-section";
import { EnergyCostNote } from "@/features/now/components/energy-cost-note";
import { LateCommitmentBanner } from "@/features/now/components/late-commitment-banner";
import { NeedsAnswerList } from "@/features/now/components/needs-answer-list";
import { NothingFitsPanel } from "@/features/now/components/nothing-fits-panel";
import { PrepPaceBanner } from "@/features/now/components/prep-pace-banner";
import { StartByBanner } from "@/features/now/components/start-by-banner";
import { CanDoNowList } from "@/features/now/components/can-do-now-list";
import { ProtectedCommitmentPanel } from "@/features/now/components/protected-commitment-panel";
import { ReachableList } from "@/features/now/components/reachable-list";
import { ReconciliationPanel } from "@/features/now/components/reconciliation-panel";
import { LoggedToast } from "@/features/now/components/logged-toast";
import { startFloor } from "@/features/now/logged-session";
import { RecommendationPanel } from "@/features/now/components/recommendation-panel";
import { RecoveryWindowLine } from "@/features/now/components/recovery-window-line";
import { RecoveryPanel } from "@/features/now/components/recovery-panel";
import { RoutineStepPanel } from "@/features/now/components/routine-step-panel";
import { SessionFeedbackPanel } from "@/features/now/components/session-feedback-panel";
import { SleepPanel } from "@/features/now/components/sleep-panel";
import { TravelPanel } from "@/features/now/components/travel-panel";
import { UpcomingStrip } from "@/features/now/components/upcoming-strip";
import { serverNow } from "@/features/planning/planning-runtime";
import { nextTaskTitle, recordedUpTo } from "@/features/now/wake-commands";
import { WakeRoutinePanel } from "@/features/now/components/wake-routine-panel";
import { FirstRunCard } from "@/features/now/components/first-run-card";
import { HeroSkeleton } from "@/components/hero-skeleton";
import { NowHero } from "@/features/now/components/now-hero";
import { WelcomeBackBanner } from "@/features/now/components/welcome-back-banner";
import { ReviewDueLine } from "@/features/review/components/review-due-line";
import { ClosedByAgentLine } from "@/features/closed/components/closed-by-agent-line";
import { AgentChangesLine } from "@/features/now/components/agent-changes-line";
import { PulseBadge } from "@/features/pulse/components/pulse-badge";
import { ReentryPanel } from "@/features/pulse/components/reentry-panel";
import { ReentryUndoBanner } from "@/features/pulse/components/reentry-undo-banner";
import type { ReentryDone } from "@/features/pulse/reentry-client";
import { pulseNeedsReentry } from "@/features/pulse/pulse-view";
import { useWelcomeBack } from "@/features/welcome-back/use-welcome-back";
import { recommendationKicker, travelKicker } from "@/features/now/components/recommendation-panel";
import { windDownOffered } from "@/features/now/wind-down";
import { todayFreeTime } from "@/features/now/today-free-time";
import styles from "@/features/now/now-page.module.css";

const MANUAL_BEDTIME_STORAGE_KEY = "openrhen:manual-bedtime-sleep-plan-id";

/**
 * The countdown formula `buildNowModel` uses for a session's `secondsRemaining`, duplicated here
 * rather than imported: the model is built once a minute (below) so the candidate ranking and every
 * other derived value it carries are not recomputed on every tick, but a running session's own
 * countdown still needs to move every second. The `Live*` wrappers below are what supply that —
 * each subscribes to the second clock itself, so only the one panel showing a countdown re-renders
 * every tick rather than the whole page.
 */
function secondsRemainingFor(session: ActiveSession, now: Date): number {
  return session.status === "paused"
    ? (session.pausedRemainingSeconds ?? 0)
    : Math.ceil((new Date(session.plannedEndAt).getTime() - now.getTime()) / 1000);
}

/** The status-row clock, to the minute: a seconds display is the only thing that would move on a calm page. */
function LiveClock({ timezone }: { timezone: string }) {
  const now = useNow("minute");
  return <time dateTime={now.toISOString()}>{clock(now, timezone)}</time>;
}

function LiveActivitySessionPanel(
  props: Omit<ComponentProps<typeof ActivitySessionPanel>, "now" | "secondsRemaining">
) {
  const now = useNow("second");
  return <ActivitySessionPanel {...props} now={now} secondsRemaining={secondsRemainingFor(props.session, now)} />;
}

function LiveActionSessionPanel(props: Omit<ComponentProps<typeof ActionSessionPanel>, "now" | "secondsRemaining">) {
  const now = useNow("second");
  return <ActionSessionPanel {...props} now={now} secondsRemaining={secondsRemainingFor(props.session, now)} />;
}

function LiveDeliverableSessionPanel(
  props: Omit<ComponentProps<typeof DeliverableSessionPanel>, "now" | "secondsRemaining" | "sessionCheckpointReached">
) {
  const now = useNow("second");
  const secondsRemaining = secondsRemainingFor(props.session, now);
  return (
    <DeliverableSessionPanel
      {...props}
      now={now}
      secondsRemaining={secondsRemaining}
      sessionCheckpointReached={props.session.status === "running" && secondsRemaining <= 0}
    />
  );
}

function LiveSessionFeedbackPanel(props: Omit<ComponentProps<typeof SessionFeedbackPanel>, "now">) {
  const now = useNow("second");
  return <SessionFeedbackPanel {...props} now={now} />;
}

/**
 * `SleepPanel` itself only rounds `now` to minutes, but it renders a live countdown card whenever a
 * bedtime routine step is being actively worked (`stepSession`) — the one part of it that needs a
 * fresh `secondsRemaining` every second.
 */
function LiveSleepPanel(props: Omit<ComponentProps<typeof SleepPanel>, "secondsRemaining">) {
  const now = useNow("second");
  const secondsRemaining = props.stepSession ? secondsRemainingFor(props.stepSession, now) : 0;
  return <SleepPanel {...props} secondsRemaining={secondsRemaining} />;
}

/** Same shape as `LiveSleepPanel`, for the wake routine's own step-in-progress countdown. */
function LiveWakeRoutinePanel(props: Omit<ComponentProps<typeof WakeRoutinePanel>, "secondsRemaining">) {
  const now = useNow("second");
  const secondsRemaining = props.stepSession ? secondsRemainingFor(props.stepSession, now) : 0;
  return <WakeRoutinePanel {...props} secondsRemaining={secondsRemaining} />;
}

/**
 * The banners that answer to the engine's own ground truth rather than to whichever session happens
 * to be running — start-by warnings, prep pace, a disruption worth renegotiating, and a protected
 * commitment gone late — mounted identically across every one of the four running-session branches
 * below. Before this, prep pace, disruption and the protected-commitment banner (like the check-in
 * banner, which each branch already mounts itself) were reachable only from the final no-session
 * branch, even though `prepPace`, `disruption` and `protectedCommitment` are computed unconditionally
 * regardless of `session`. Not used by the no-session branch itself: it
 * renders `ProtectedCommitmentPanel` directly, whose own headline already covers a late commitment
 * when nothing else is running against it.
 */
function SessionIndependentBanners({
  prepPace,
  startByWarnings,
  disruption,
  disruptionRefreshKey,
  protectedCommitment,
  storedProtectedCommitment,
  session,
  state,
  now,
  timezone,
  saving,
  saveEntityCommand
}: {
  prepPace: PrepPace | undefined;
  startByWarnings: StartByWarning[];
  disruption: StoredCommitment | null;
  disruptionRefreshKey: string | number | undefined;
  protectedCommitment: NowProtectedCommitment | undefined;
  storedProtectedCommitment: StoredCommitment | undefined;
  session: ActiveSession | null;
  state: PortalState;
  now: Date;
  timezone: string;
  saving: boolean;
  saveEntityCommand: SaveEntityCommand;
}) {
  // The one exception to "show it regardless of session": a commitment the running session is itself
  // tracking already has its own panel saying so. Naming it again here would just be the same fact
  // twice, once as a compact banner and once as the session panel already on screen.
  const sessionTracksThisCommitment = Boolean(
    session &&
    protectedCommitment &&
    session.targetType === "fixed_commitment" &&
    session.targetId === protectedCommitment.id
  );
  return (
    <>
      <StartByBanner warnings={startByWarnings} state={state} timezone={timezone} />
      <PrepPaceBanner prepPace={prepPace} timezone={timezone} />
      {disruption && (
        <RenegotiationPanel
          disruption={disruption}
          state={state}
          now={now}
          timezone={timezone}
          saving={saving}
          saveEntityCommand={saveEntityCommand}
          refreshKey={disruptionRefreshKey}
        />
      )}
      {protectedCommitment && !sessionTracksThisCommitment && (
        <LateCommitmentBanner
          protectedCommitment={protectedCommitment}
          storedProtectedCommitment={storedProtectedCommitment}
          state={state}
          timezone={timezone}
          saving={saving}
          saveEntityCommand={saveEntityCommand}
        />
      )}
    </>
  );
}

export default function NowPage() {
  const {
    state,
    ready,
    saving,
    recommendation,
    forecasts,
    currentDirective,
    upcomingDirectives,
    continuation,
    startCurrent,
    correctStart,
    stopToSwitch,
    switchPending,
    clearSwitchPending,
    switchedFrom,
    switchAwaitingPlan,
    forgetSwitch,
    focusNewSession,
    clearFocusNewSession,
    loggedSession,
    startAlternative,
    blockRecommended,
    snoozeAction,
    pauseOrResume,
    requestFeedback,
    finishSession,
    saveEntityCommand,
    runActivityCommand,
    replay,
    live,
    knownLatestSuccessfulAt,
    planHealth,
    recalculate,
    dayPlan,
    serverClockOffsetMs,
    slots
  } = usePortal();
  // The candidate ranking, sleep/routine derivation and everything else `buildNowModel` computes do
  // not need to notice the passage of a mere second, so this page subscribes at a minute's
  // granularity. The status-row clock and a running session's own countdown are the two things that
  // genuinely tick every second; each gets its own second-clock subscription below (`LiveClock`,
  // `Live*SessionPanel`) rather than forcing this whole tree to re-render sixty times a minute.
  const now = useNow("minute");
  const welcomeBack = useWelcomeBack();
  // The last re-entry, kept so its Undo outlives the sheet that made it.
  const [reentered, setReentered] = useState<ReentryDone | null>(null);
  // Leaving Now drops a pending "switch": Something else should not open the next time Now is shown.
  useEffect(() => forgetSwitch, [forgetSwitch]);
  const [remainingChoice, setRemainingChoice] = useState("keep");
  const [customRemaining, setCustomRemaining] = useState(120);
  const [blockReason, setBlockReason] = useState<BlockingReason>("missing_information");
  const [overrideReason, setOverrideReason] = useState<OverrideReason>("better_fit");
  const [note, setNote] = useState("");
  const [manualBedtime, setManualBedtime] = useState(false);
  // "I was working the whole time" settles the trail and leaves the session running, but nothing on
  // the server retimes `session.unansweredCheckIns` until the next state read arrives — see
  // `reloadState`'s own note that a poll already in flight is deferred, and the check-in command path
  // deliberately does not trigger one (Phase A is record-only). This local override is this page's
  // own "already settled" memory for the session, the same idea as `manualBedtime`'s local storage
  // flag, so the ordinary session/checkpoint panel returns immediately rather than waiting on a poll.
  const [reconciledSessionIds, setReconciledSessionIds] = useState<Set<string>>(new Set());
  const model = useMemo(
    () =>
      buildNowModel({
        state,
        recommendation,
        forecasts,
        currentDirective,
        now,
        serverClockOffsetMs,
        manualBedtime,
        knownLatestSuccessfulAt
      }),
    [
      state,
      recommendation,
      forecasts,
      currentDirective,
      now,
      serverClockOffsetMs,
      manualBedtime,
      knownLatestSuccessfulAt
    ]
  );
  // Today's selector, shared with the Today page's "What changed" panel — the same record so the
  // two surfaces never name a different disruption.
  const disruption = useMemo(() => activeDisruption(state, now), [state, now]);
  const {
    timezone,
    planningDecisionCurrent,
    planningRefreshing,
    session,
    sessionAction,
    primary,
    situationLocation,
    situationLocationTrusted,
    needsAnswer,
    reachable,
    worthTheTrip,
    notWorthTheTrip,
    forecast,
    reconciliationDue,
    plannedStart,
    plannedEnd,
    plannedDuration,
    nextCommitment,
    protectedCommitment,
    storedProtectedCommitment,
    openAnchor,
    storedOpenAnchor,
    upcomingSleep,
    currentBedtimeStep,
    currentWakeStep,
    sleepPanelDue,
    sleepDue,
    sleepEarlyStart,
    sleepMinutesUntilPlannedStart,
    sleepEarlyStartWakeAt,
    sleepConstrainedMinutes,
    sleepNapTopUpMinutes,
    deliverableDirective,
    directedDeliverable,
    answerDirective,
    answerOptions,
    boundaryDirective,
    boundaryIsDailyHorizon,
    travelDirective,
    travelDestination,
    routineDue,
    wakeShiftMinutes,
    commitmentAfterWake,
    wakeToCommitmentMinutes,
    tentativeSleepConflict,
    sleepSuggestion,
    stayUpOffer,
    activeSleepPlan,
    stepSession,
    prepPace,
    startByWarnings,
    canDoNow,
    needs,
    stretchOffer,
    stretch,
    energyCost
  } = model;
  // Keyed to the specific plan rather than just "on/off" so a reload can tell a still-current early
  // start from a stale one left over from a previous night's plan, which by then has a different id.
  const upcomingSleepId = upcomingSleep?.id;
  useEffect(() => {
    let remembered = false;
    if (upcomingSleepId) {
      try {
        remembered = window.localStorage.getItem(MANUAL_BEDTIME_STORAGE_KEY) === upcomingSleepId;
      } catch {
        remembered = false;
      }
    }
    // oxlint-disable-next-line react/set-state-in-effect -- the flag lives in localStorage, which cannot be read while rendering without a hydration mismatch
    setManualBedtime(remembered);
  }, [upcomingSleepId]);
  const startManualBedtime = () => {
    if (!upcomingSleep) return;
    setManualBedtime(true);
    try {
      window.localStorage.setItem(MANUAL_BEDTIME_STORAGE_KEY, upcomingSleep.id);
    } catch {}
  };
  const cancelManualBedtime = () => {
    setManualBedtime(false);
    try {
      window.localStorage.removeItem(MANUAL_BEDTIME_STORAGE_KEY);
    } catch {}
  };
  // Never during a frozen replay, whose whole point is that nothing about it can touch live data.
  // Refires whenever the held assertion crosses its staleness threshold while this page stays open,
  // not just on the initial load.
  const { suggestion: browserLocationSuggestion, dismiss: dismissBrowserLocationSuggestion } = useLocationObservation({
    enabled: ready && !replay,
    refreshKey: situationLocationTrusted
  });
  // A phone-sourced suggestion is answered for the rest of this page's life once declined, the same
  // as a browser one; a fresh reading replacing it (a new `observedAt`) is what earns it another ask.
  const [phoneLocationSuggestionDismissed, setPhoneLocationSuggestionDismissed] = useState(false);
  const pendingSuggestionObservedAt = state.pendingLocationSuggestion?.observedAt;
  const [dismissalObservedAt, setDismissalObservedAt] = useState(pendingSuggestionObservedAt);
  if (dismissalObservedAt !== pendingSuggestionObservedAt) {
    setDismissalObservedAt(pendingSuggestionObservedAt);
    setPhoneLocationSuggestionDismissed(false);
  }
  // The browser's own reading, taken moments ago, outranks a phone suggestion that may be stale by
  // comparison — and the server clears or replaces the stored one in lockstep with what this hook
  // just learned, so preferring it here does not risk showing a suggestion the server has moved past.
  const locationPrompt: LocationPromptView | null = browserLocationSuggestion
    ? { locationId: browserLocationSuggestion.locationId, locationName: browserLocationSuggestion.locationName }
    : state.pendingLocationSuggestion && !phoneLocationSuggestionDismissed
      ? {
          locationId: state.pendingLocationSuggestion.locationId,
          locationName: state.pendingLocationSuggestion.locationName
        }
      : null;
  function confirmLocationPrompt() {
    if (!locationPrompt) return;
    void saveEntityCommand(situationCommand(state, { locationId: locationPrompt.locationId }));
    if (browserLocationSuggestion) dismissBrowserLocationSuggestion();
    else {
      setPhoneLocationSuggestionDismissed(true);
      void dismissPendingLocationSuggestion();
    }
  }
  function dismissLocationPrompt() {
    if (browserLocationSuggestion) dismissBrowserLocationSuggestion();
    else {
      setPhoneLocationSuggestionDismissed(true);
      void dismissPendingLocationSuggestion();
    }
  }

  const nowViewBase = buildNowViewBase({ state, recommendation, currentDirective, model });

  const situation = (
    <AvailabilityPanel
      state={state}
      saving={saving}
      now={now}
      situationLocation={situationLocation}
      situationLocationTrusted={situationLocationTrusted}
      sleepDue={Boolean(sleepDue)}
      saveEntityCommand={saveEntityCommand}
      locationPrompt={locationPrompt}
      onConfirmLocationPrompt={confirmLocationPrompt}
      onDismissLocationPrompt={dismissLocationPrompt}
      variant="summary"
    />
  );
  const liveLabel = live ? "Live updates connected" : "Live updates off, polling";
  // The date and time, whether the plan is current, and the situation chips: one line above the hero.
  const dateLine = (
    <p className={styles.date} data-plan-status="">
      <span className={styles.live} data-live={live} title={liveLabel} aria-label={liveLabel} />
      {localDate(now, timezone)} · <LiveClock timezone={timezone} /> ·{" "}
      {planStatusChip({
        saving,
        planningRefreshing,
        planningDecisionCurrent,
        planHealth,
        stateAwaitingRecalculation: state.planning?.awaitingRecalculation
      })}{" "}
      <PulseBadge pulse={state.pulse} />
    </p>
  );
  const top = (
    <div className={styles.top}>
      {dateLine}
      {situation}
    </div>
  );
  // Beside the hero on a desk, under it on a phone: what comes next, then the quieter lists. The facts
  // that have gone stale and do not change the directive ("Also check") come second, after Up next.
  const side = (alsoCheck: ReactNode) => (
    <aside className={styles.side}>
      <ReviewDueLine />
      {upcomingDirectives.length > 0 && <UpcomingStrip directives={upcomingDirectives} state={state} />}
      {alsoCheck}
      {needsAnswer.length > 0 && <NeedsAnswerList items={needsAnswer} state={state} />}
      {reachable.length > 0 && (
        <ReachableList worthTheTrip={worthTheTrip} notWorthTheTrip={notWorthTheTrip} state={state} />
      )}
      {/* The least urgent thing on the page by construction (the design note's own risk note), so last. */}
      {extensionBanners().map((Banner, index) => (
        <Banner key={index} />
      ))}
    </aside>
  );
  const lapsed = !replay && pulseNeedsReentry(state.pulse);
  const page = (primary: ReactNode, mode: Parameters<typeof ReportIssue>[0]["view"]["mode"]) => {
    // What the hero already asks is not listed again: the checkpoint has "It ended at", the answer panel the place.
    const hero: NeedsHero = mode === "feedback" ? "checkpoint" : mode === "answer" ? "place" : "other";
    const listed = visibleNeeds(needs, hero);
    const factNeeds = {
      state,
      session,
      now,
      timezone,
      saving,
      saveEntityCommand,
      finishSession,
      runActivityCommand
    };
    return (
      <main className={cx("now-page", styles.page)}>
        {top}
        <div className={styles.grid}>
          <div className={styles.primary}>
            {reentered && <ReentryUndoBanner done={reentered} onClose={() => setReentered(null)} />}
            {lapsed && <ReentryPanel onDone={setReentered} />}
            {/* Above everything else in the column: a fact the directive waits on outranks the directive. */}
            <FactNeeds
              needs={listed.filter((need) => need.blocksDirective)}
              label="Needs an answer first"
              {...factNeeds}
            />
            {primary}
            <StretchSection offer={stretchOffer} stretch={stretch} timezone={timezone} />
            <EnergyCostNote energyCost={energyCost} />
          </div>
          {side(
            <FactNeeds
              needs={listed.filter((need) => !need.blocksDirective)}
              heading="Also check"
              label="Also check"
              {...factNeeds}
            />
          )}
        </div>
        <ReportIssue view={{ ...nowViewBase, mode }} />
        <LoggedToast logged={loggedSession} />
      </main>
    );
  };
  const banners = session ? (
    <SessionIndependentBanners
      prepPace={prepPace}
      startByWarnings={startByWarnings}
      disruption={disruption}
      disruptionRefreshKey={knownLatestSuccessfulAt ?? undefined}
      protectedCommitment={protectedCommitment}
      storedProtectedCommitment={storedProtectedCommitment}
      session={session}
      state={state}
      now={now}
      timezone={timezone}
      saving={saving}
      saveEntityCommand={saveEntityCommand}
    />
  ) : null;

  if (!ready)
    return (
      <main className={cx("now-page", styles.page)}>
        <HeroSkeleton label="Preparing your plan" />
        <ReportIssue view={{ ...nowViewBase, mode: "loading" }} />
      </main>
    );

  // The pulse is off/lapsed: the re-entry sheet stands in for the directive (and for the welcome-back banner, whose
  // catch-up row it absorbs) until it is completed. Never during a frozen replay.
  // With a session running the sheet goes above its panel instead (inside `page`), so Stop and Finish stay reachable.
  if (lapsed && !session)
    return (
      <main className={cx("now-page", styles.page)}>
        {/* Without the situation chips: they are the facts from before the gap, which this sheet asks afresh. */}
        <div className={styles.top}>{dateLine}</div>
        <ReentryPanel onDone={setReentered} />
        <ReportIssue view={{ ...nowViewBase, mode: "loading", bannerText: "Pulse lapsed: re-entry sheet shown" }} />
      </main>
    );

  if (
    session &&
    (session.targetType === "sleep" ||
      session.targetType === "routine_step" ||
      (session.targetType === "routine_instance" && !session.stepId) ||
      session.targetType === "fixed_commitment")
  )
    return page(
      <>
        {/* Above the running session for the same reason it sits above the directive on the
            no-session page: a ground-truth question about what the engine already believes
            outranks whatever the page is otherwise showing. */}
        <CheckInBanner />
        {banners}
        <NowHero>
          <ActionBar>
            <LiveActivitySessionPanel
              session={session}
              state={state}
              timezone={timezone}
              saving={saving}
              activeSleepPlan={activeSleepPlan}
              serverClock={() => serverNow(serverClockOffsetMs)}
              runActivityCommand={runActivityCommand}
              saveEntityCommand={saveEntityCommand}
            />
          </ActionBar>
        </NowHero>
      </>,
      "activity_session"
    );

  if (session?.targetType === "deliverable") {
    // "The panel never appears for a paused session or one with fewer than three unanswered slots;
    // those keep the catch-up prompt they have today" — `reconciliationDue` already excludes both,
    // and the local override below is this page's own memory that "I was working the whole time" was
    // just answered, so the ordinary session panel returns without waiting on the next poll.
    const showReconciliation = reconciliationDue && !reconciledSessionIds.has(session.id);
    return page(
      <>
        {/* The reconciliation ladder's newest rung is the one question worth asking — a separate
            "Still on X?" banner on top of it would let answering that alone silently verify
            everything before it. */}
        {!showReconciliation && <CheckInBanner />}
        {banners}
        <NowHero>
          <ActionBar>
            {showReconciliation ? (
              <ReconciliationPanel
                session={session}
                state={state}
                now={now}
                timezone={timezone}
                saving={saving}
                runActivityCommand={runActivityCommand}
                onSettled={() => setReconciledSessionIds((current) => new Set(current).add(session.id))}
              />
            ) : (
              <LiveDeliverableSessionPanel
                session={session}
                state={state}
                timezone={timezone}
                saving={saving}
                runActivityCommand={runActivityCommand}
              />
            )}
          </ActionBar>
        </NowHero>
      </>,
      "activity_session"
    );
  }

  if (session?.status === "feedback" && sessionAction)
    return page(
      <>
        <CheckInBanner />
        {banners}
        <NowHero label="Checkpoint">
          <LiveSessionFeedbackPanel
            sessionAction={sessionAction}
            state={state}
            timezone={timezone}
            saving={saving}
            plannedStart={plannedStart}
            plannedEnd={plannedEnd}
            plannedDuration={plannedDuration}
            planningDecisionCurrent={planningDecisionCurrent}
            continuation={continuation}
            remainingChoice={remainingChoice}
            onRemainingChoiceChange={setRemainingChoice}
            customRemaining={customRemaining}
            onCustomRemainingChange={setCustomRemaining}
            blockReason={blockReason}
            onBlockReasonChange={setBlockReason}
            note={note}
            onNoteChange={setNote}
            finishSession={finishSession}
          />
        </NowHero>
      </>,
      "feedback"
    );

  if (session && sessionAction)
    return page(
      <>
        <CheckInBanner />
        {banners}
        <NowHero label="Session in progress">
          <ActionBar>
            <LiveActionSessionPanel
              session={session}
              sessionAction={sessionAction}
              state={state}
              timezone={timezone}
              saving={saving}
              plannedStart={plannedStart}
              plannedEnd={plannedEnd}
              plannedDuration={plannedDuration}
              onPauseOrResume={() => void pauseOrResume()}
              onRequestFeedback={() => void requestFeedback().catch(() => undefined)}
              onCorrectStart={correctStart}
              onSwitch={stopToSwitch}
              focusOnMount={focusNewSession === session.id}
              onFocused={clearFocusNewSession}
            />
          </ActionBar>
        </NowHero>
      </>,
      "action_session"
    );

  // Nothing for the hero to say: no directive, and none of the state-derived panels (sleep, a routine, a
  // protected commitment) has anything either. For someone brand new (setup never done, no work saved)
  // that is a way in rather than "nothing fits"; while a first plan is still being worked out it is the
  // hero's own shape, waiting. Someone with work but no setup record still gets the ordinary page.
  const heroEmpty =
    !travelDirective &&
    !protectedCommitment &&
    !sleepDue &&
    !currentWakeStep &&
    !routineDue &&
    !primary &&
    !answerDirective &&
    !boundaryDirective &&
    currentDirective?.kind !== "recovery";
  const firstRun = heroEmpty && !state.settings.setupCompletedAt && state.actions.length === 0;
  const firstPlanOnItsWay =
    heroEmpty &&
    !firstRun &&
    !state.planning?.result &&
    state.planning?.status === "pending" &&
    planHealth?.refresh !== "stalled";
  const showsWork = !travelDirective && !protectedCommitment && !sleepDue && !currentWakeStep && !routineDue;
  // Whether the hero is the recommendation itself, whose Something else sheet carries the quiet ways in.
  const recommendationHero = !firstRun && !firstPlanOnItsWay && showsWork && Boolean(primary);
  // Right after Finished it the stored plan still names the finished action until the next plan lands.
  const primaryFinished = showsWork && recommendedActionFinished(state, primary);
  const area = showsWork && !primaryFinished ? projectTitle(state, primary?.action.projectId) : "";
  // What kind of moment the hero is, in a few words above the headline.
  const notBefore = (currentDirective as { notBefore?: string } | null | undefined)?.notBefore;
  const breakEndsAt = notBefore && new Date(notBefore) > now ? new Date(notBefore) : null;
  const kicker = firstRun
    ? "Welcome"
    : travelDirective
      ? travelKicker(timezone, breakEndsAt)
      : protectedCommitment
        ? "Happening now"
        : sleepDue
          ? "Bedtime"
          : currentWakeStep
            ? "Morning routine"
            : routineDue
              ? "Routine"
              : primary && !primaryFinished
                ? recommendationKicker(primary, plannedEnd, timezone, breakEndsAt)
                : currentDirective?.kind === "recovery"
                  ? "Rest"
                  : answerDirective
                    ? "A quick question first"
                    : boundaryDirective
                      ? "Wrapping up"
                      : "Now";
  const windDown =
    !travelDirective &&
    !protectedCommitment &&
    !sleepDue &&
    upcomingSleep &&
    windDownOffered(upcomingSleep.plannedStartAt, now)
      ? { label: "Start winding down for bed now", onChoose: startManualBedtime }
      : null;
  const freeToday = todayFreeTime(slots, now, timezone);

  return page(
    <>
      {/*
        Above the hero: the start-by banner, then prep pace — the engine already knows a step's latest
        start is soon or missed, or that getting ready for the next commitment will not fit (or is about
        to stop fitting). Then welcome-back (catch-up and what changed while away), the check-in
        question, and a disruption worth renegotiating: each a different kind of thing than the
        suggestion for right now, and each renders nothing when it has nothing to say.
      */}
      <StartByBanner warnings={startByWarnings} state={state} timezone={timezone} />
      <PrepPaceBanner prepPace={prepPace} timezone={timezone} />
      <WelcomeBackBanner {...welcomeBack} timezone={timezone} />
      <AgentChangesLine
        count={welcomeBack.agentChangesSinceLooked}
        neverLooked={welcomeBack.agentChangesNeverLooked}
        coveredByWelcomeBack={welcomeBack.show && welcomeBack.rows.some((row) => row.key === "agent-changes")}
      />
      <ClosedByAgentLine />
      <CheckInBanner />
      {disruption && (
        <RenegotiationPanel
          disruption={disruption}
          state={state}
          now={now}
          timezone={timezone}
          saving={saving}
          saveEntityCommand={saveEntityCommand}
          refreshKey={knownLatestSuccessfulAt ?? undefined}
        />
      )}
      {/* The hero: the one thing to do now, and every way of answering it. */}
      {firstPlanOnItsWay ? (
        <NowHero className="now-directive">
          <HeroSkeleton label="Working out your plan…" />
        </NowHero>
      ) : (
        <NowHero
          className="now-directive"
          label="What to do now"
          kicker={kicker}
          title={
            firstRun
              ? "Let's set up your plan"
              : /*
                  The engine's own headline covers a journey too — "Travelling to Dentist" for a
                  plan-required leg, the work's title for a directed trip — so the leg's own wording
                  ("Drive to Campus · 18 min") belongs to the panel rather than being said twice.
                */
                protectedCommitment
                ? recommendation.headline
                : sleepDue
                  ? "Time to sleep"
                  : currentWakeStep
                    ? currentWakeStep.title
                    : routineDue
                      ? routineDue.title
                      : primaryFinished
                        ? "That one is done"
                        : recommendation.headline
          }
          lead={area || undefined}
        >
          {firstRun ? (
            <FirstRunCard />
          ) : (
            <>
              {/*
                Above the suggestion rather than instead of it. An anchor is the case where the page has
                two true things to say at once — you are at this, and you have time — so it says both,
                in that order.
              */}
              {openAnchor && !travelDirective ? (
                <EngagementStrip
                  openAnchor={openAnchor}
                  storedOpenAnchor={storedOpenAnchor}
                  now={now}
                  timezone={timezone}
                  saving={saving}
                  runActivityCommand={runActivityCommand}
                />
              ) : null}
              <ActionBar>
                {/*
                  A directed journey comes first, whatever else is true. It is exclusive — there is no
                  session to start against it — and when it is the leg to a protected commitment the
                  commitment is also present, so asking about it second would draw the wrong panel.
                */}
                {travelDirective ? (
                  <TravelPanel
                    directive={travelDirective}
                    destination={travelDestination}
                    state={state}
                    saving={saving}
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                    saveEntityCommand={saveEntityCommand}
                    {...(storedProtectedCommitment
                      ? {
                          underwayCommitment: {
                            id: storedProtectedCommitment.id,
                            startsAt: storedProtectedCommitment.startsAt
                          }
                        }
                      : {})}
                  />
                ) : protectedCommitment ? (
                  <ProtectedCommitmentPanel
                    protectedCommitment={protectedCommitment}
                    storedProtectedCommitment={storedProtectedCommitment}
                    state={state}
                    now={now}
                    timezone={timezone}
                    saving={saving}
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                    runActivityCommand={runActivityCommand}
                    saveEntityCommand={saveEntityCommand}
                  />
                ) : sleepDue ? (
                  <LiveSleepPanel
                    sleepDue={sleepDue}
                    state={state}
                    timezone={timezone}
                    now={now}
                    saving={saving}
                    manualBedtime={manualBedtime}
                    sleepPanelDue={sleepPanelDue}
                    sleepEarlyStart={sleepEarlyStart}
                    sleepMinutesUntilPlannedStart={sleepMinutesUntilPlannedStart}
                    sleepEarlyStartWakeAt={sleepEarlyStartWakeAt}
                    sleepConstrainedMinutes={sleepConstrainedMinutes}
                    sleepNapTopUpMinutes={sleepNapTopUpMinutes}
                    onCancelManualBedtime={cancelManualBedtime}
                    tentativeSleepConflict={tentativeSleepConflict}
                    wakeToCommitmentMinutes={wakeToCommitmentMinutes}
                    commitmentAfterWake={commitmentAfterWake}
                    wakeShiftMinutes={wakeShiftMinutes}
                    stepSession={stepSession}
                    currentBedtimeStep={currentBedtimeStep}
                    primary={primary}
                    sleepSuggestion={sleepSuggestion}
                    stayUpOffer={stayUpOffer}
                    runActivityCommand={runActivityCommand}
                    saveEntityCommand={saveEntityCommand}
                  />
                ) : currentWakeStep ? (
                  <LiveWakeRoutinePanel
                    currentWakeStep={currentWakeStep}
                    routineSteps={state.routineSteps}
                    nextTask={nextTaskTitle(primary, dayPlan?.blocks)}
                    recordedUpTo={recordedUpTo(state)}
                    clock={() => serverNow(serverClockOffsetMs)}
                    stepSession={stepSession}
                    saving={saving}
                    runActivityCommand={runActivityCommand}
                  />
                ) : routineDue ? (
                  <RoutineStepPanel
                    routineDue={routineDue}
                    state={state}
                    now={now}
                    timezone={timezone}
                    saving={saving}
                    runActivityCommand={runActivityCommand}
                    saveEntityCommand={saveEntityCommand}
                  />
                ) : primary ? (
                  <RecommendationPanel
                    primary={primary}
                    timezone={timezone}
                    saving={saving}
                    planningDecisionCurrent={planningDecisionCurrent}
                    finished={primaryFinished}
                    planRefresh={planHealth?.refresh}
                    onRefreshPlan={() => recalculate().catch(() => undefined)}
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                    why={recommendation.why}
                    plannedEnd={plannedEnd}
                    nextCommitment={nextCommitment}
                    forecast={forecast}
                    alternatives={
                      // After Stop and choose the new plan may lead with the very task wanted, which is the
                      // primary and so not an alternative: offer it too. The task just stopped is not offered
                      // either way, as primary or as an alternative.
                      switchedFrom === null
                        ? recommendation.alternatives
                        : [...(deliverableDirective ? [] : [primary]), ...recommendation.alternatives].filter(
                            (item) => item.action.id !== switchedFrom
                          )
                    }
                    deliverableDirective={deliverableDirective}
                    directedDeliverable={directedDeliverable}
                    overrideReason={overrideReason}
                    onOverrideReasonChange={setOverrideReason}
                    // Returned, so the Start button knows when its own command is done and holds only itself until then.
                    onStartCurrent={(startedAt) => startCurrent(startedAt).catch(() => undefined)}
                    startFloor={startFloor(state, primary.action.id)}
                    openElse={switchPending}
                    planPending={switchAwaitingPlan}
                    onElseOpened={clearSwitchPending}
                    startAlternative={(actionId, plannedMinutes, reason, note) =>
                      // The primary is started with `start`; the server accepts only ranks 2 to 4 as alternatives.
                      actionId === primary.action.id
                        ? startCurrent()
                        : startAlternative(actionId, plannedMinutes, reason, note)
                    }
                    blockRecommended={blockRecommended}
                    projects={state.projects}
                    snoozeRecommended={(availableFrom) => snoozeAction(primary.action.id, availableFrom)}
                    runActivityCommand={runActivityCommand}
                    extraChoices={windDown ? [windDown] : []}
                  />
                ) : currentDirective?.kind === "recovery" ? (
                  <RecoveryPanel
                    recommendedMinutes={currentDirective.recommendedMinutes}
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                  />
                ) : answerDirective ? (
                  <AnswerPanel
                    directive={answerDirective}
                    options={answerOptions}
                    state={state}
                    saving={saving}
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                    saveEntityCommand={saveEntityCommand}
                  />
                ) : boundaryDirective ? (
                  <BoundaryPanel
                    directive={boundaryDirective}
                    isDailyHorizon={boundaryIsDailyHorizon}
                    state={state}
                    now={now}
                    timezone={timezone}
                    saving={saving}
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                    saveEntityCommand={saveEntityCommand}
                  />
                ) : (
                  <NothingFitsPanel
                    explanation={recommendation.explanation}
                    evidence={recommendation.evidence}
                    workIsTheProblem={currentDirective?.kind === "none"}
                  />
                )}
              </ActionBar>
            </>
          )}
        </NowHero>
      )}
      {/* Everything else on offer right now, under the hero rather than competing with it. */}
      <CanDoNowList
        items={canDoNow}
        state={state}
        timezone={timezone}
        saving={saving}
        runActivityCommand={runActivityCommand}
      />
      {/* One quiet line under the directive: today's protected recovery window, with its skip. */}
      <RecoveryWindowLine
        state={state}
        now={now}
        timezone={timezone}
        saving={saving}
        saveEntityCommand={saveEntityCommand}
      />
      {/* Quiet by design — this is a note, not a panel. The diff itself lives on Day. */}
      {disruption && (
        <p className={styles.note}>
          <a href="/today">Replanned around {disruption.title}</a>
        </p>
      )}
      {/* The recommendation's Something else sheet already holds these; every other hero needs them here. */}
      {!recommendationHero ? (
        <div className={styles.more}>
          {windDown ? (
            <Button variant="ghost" size="sm" disabled={saving} onClick={windDown.onChoose}>
              {windDown.label}
            </Button>
          ) : null}
          {/* The one-tap way in: whatever the page is showing, life can interrupt it. */}
          <Button variant="ghost" size="sm" onClick={() => openCaptureSheet("disruption")}>
            Something came up
          </Button>
        </div>
      ) : null}
      {freeToday && !firstRun ? (
        <Card padded className={styles.today}>
          <div className={styles.todayText}>
            <div className={styles.todayLine}>
              <p>Rest of today</p>
              <p>
                {hoursMinutes(freeToday.freeMinutes)} free of {hoursMinutes(freeToday.awakeMinutes)}
              </p>
            </div>
            <Meter
              value={(freeToday.awakeMinutes - freeToday.freeMinutes) / freeToday.awakeMinutes}
              label="Rest of today already planned"
            />
          </div>
          <ButtonLink href="/today" variant="ghost" size="sm">
            Open Day
          </ButtonLink>
        </Card>
      ) : null}
    </>,
    travelDirective
      ? "travel"
      : protectedCommitment
        ? "protected_commitment"
        : sleepDue
          ? "sleep_due"
          : routineDue
            ? "routine_due"
            : primary
              ? "recommendation"
              : currentDirective?.kind === "recovery"
                ? "recovery"
                : answerDirective
                  ? "answer"
                  : boundaryDirective
                    ? "boundary"
                    : "nothing_fits"
  );
}
