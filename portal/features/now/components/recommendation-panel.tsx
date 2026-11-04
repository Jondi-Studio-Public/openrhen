"use client";

import { useEffect, useRef, useState } from "react";
import type { BlockingReason, OverrideReason } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import { useNow } from "@/shared/clock";
import { openCaptureSheet } from "@/shared/use-capture-sheet";
import type { StoredCommitment } from "@/state/portal-state";
import { Sheet } from "@/components/sheet";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Chip } from "@/components/ui/chip";
import { List, ListRow } from "@/components/ui/list-row";
import { cx } from "@/components/ui/cx";
import { clock, formatScore, hoursMinutes, plainWhySentence } from "@/features/now/now-formatting";
import type {
  BlockRecommended,
  DeliverableDirective,
  DirectedDeliverable,
  NowCandidate,
  NowForecast,
  RunActivityCommand,
  StartAlternative
} from "@/features/now/now-model";
import { criticalTierLabel, type CriticalTier } from "@/features/now/critical-tiers";
import type { ClientRecommendationWhy } from "@/state/portal-provider";
import type { PlanRefreshState } from "@/features/planning/planning-runtime";
import { healthChipText, localiseReason } from "@/features/plan/plan-formatting";
import { canSnooze, snoozeTarget } from "@/features/now/snooze";
import { BLOCKING_REASONS } from "./blocking-reasons";
import { SnoozePicker } from "./snooze-picker";
import {
  StartedEarlier,
  startedAtFor,
  startedEarlierProblem,
  startLabel,
  type StartedEarlierChoice
} from "./started-earlier";
import styles from "../now-page.module.css";

/** External and behind read as danger, a stale date as plain, the rest of the critical tiers as warn. */
function tierTone(tier: CriticalTier | undefined): BadgeTone {
  switch (tier) {
    case "overdue_external":
    case "behind_external":
    case "behind_internal":
      return "danger";
    case "stale_date":
      return "neutral";
    case "ordinary":
    case undefined:
      return "accent";
    default:
      return "warn";
  }
}

const OVERRIDE_REASONS: { value: OverrideReason; label: string }[] = [
  { value: "better_fit", label: "Better fit now" },
  { value: "lower_energy", label: "Lower energy" },
  { value: "context_unavailable", label: "Can't do it here" },
  { value: "deadline_judgment", label: "Deadline call" },
  { value: "maintain_momentum", label: "Keep momentum" },
  { value: "personal_priority", label: "Matters more to me" },
  { value: "other", label: "Other" }
];

/** How long the suggestion is for, in the kicker's own words: "about 45 min, until 9:20 am". */
export function recommendationKicker(
  primary: NowCandidate,
  plannedEnd: Date,
  timezone: string,
  breakEndsAt?: Date | null
): string {
  if (breakEndsAt)
    return `After a break until ${clock(breakEndsAt, timezone)} · about ${primary.recommendedMinutes} min, until ${clock(plannedEnd, timezone)}`;
  return `Do this now · about ${primary.recommendedMinutes} min, until ${clock(plannedEnd, timezone)}`;
}

/** A journey's kicker: "Time to go", or the break first when the work it leads to is still resting. */
export function travelKicker(timezone: string, breakEndsAt?: Date | null): string {
  return breakEndsAt ? `Take a break until ${clock(breakEndsAt, timezone)}, then leave` : "Time to go";
}

/**
 * The recommended piece of work, answered three ways: Start, Not now (a sheet of reasons, one tap
 * each, which marks it blocked), or Something else (a sheet of what else fits, plus "Something came
 * up"). Under the buttons, why this and why now in plain sentences, with the engine's workings one
 * more tap away.
 */
export function RecommendationPanel({
  primary,
  timezone,
  saving,
  planningDecisionCurrent,
  planRefresh,
  onRefreshPlan,
  explanation,
  evidence,
  why,
  plannedEnd,
  nextCommitment,
  forecast,
  alternatives,
  deliverableDirective,
  directedDeliverable,
  overrideReason,
  onOverrideReasonChange,
  onStartCurrent,
  startAlternative,
  blockRecommended,
  snoozeRecommended,
  projects = [],
  runActivityCommand,
  extraChoices,
  openElse,
  onElseOpened,
  planPending,
  startFloor,
  finished
}: {
  primary: NowCandidate;
  timezone: string;
  saving: boolean;
  /** Behaviour contract: a stale plan cannot authorize Start. Capture and Not now stay available. */
  planningDecisionCurrent: boolean;
  /** Why the plan is not current, when the last status poll said: a refresh under way reads differently from a stuck one. */
  planRefresh?: PlanRefreshState | undefined;
  /** Asks for a new plan; offered beside the disabled Start only when the plan lapsed with none on its way. A stalled refresh already has the banner's own button. */
  onRefreshPlan?: (() => void) | undefined;
  explanation: string;
  evidence: readonly string[];
  /** Absent for a result stored before the engine explained itself contrastively. */
  why?: ClientRecommendationWhy | undefined;
  plannedEnd: Date;
  nextCommitment: StoredCommitment | undefined;
  forecast: NowForecast | undefined;
  alternatives: readonly NowCandidate[];
  deliverableDirective: DeliverableDirective | null;
  directedDeliverable: DirectedDeliverable | undefined;
  overrideReason: OverrideReason;
  onOverrideReasonChange: (reason: OverrideReason) => void;
  /** `startedAt` backdates the start when the person says the work began earlier. */
  onStartCurrent: (startedAt?: string) => void;
  startAlternative: StartAlternative;
  blockRecommended: BlockRecommended;
  /** Puts the recommendation off until an instant, without blocking it. Absent hides the snooze choices. */
  snoozeRecommended?: ((availableFrom: string) => Promise<void>) | undefined;
  /** Read for the project's external deadline, which bounds a snooze. */
  projects?: readonly { id: string; externalDeadlineAt?: string | undefined }[];
  runActivityCommand: RunActivityCommand;
  /** Further rows for the Something else sheet, such as winding down for bed early. */
  extraChoices?: { label: string; meta?: string; onChoose: () => void }[];
  /** Opens Something else as soon as it is true: the last session just ended "to switch". */
  openElse?: boolean;
  onElseOpened?: () => void;
  /** The plan that follows a stop-to-switch has not landed, so an empty list is not yet an answer. */
  planPending?: boolean;
  /** The earliest a start can be put back to; "Started earlier?" chips below it are off. */
  startFloor?: Date | null;
  /** The recommended action is already finished in local state; the plan just has not moved on. No Start, no Not now. */
  finished?: boolean;
}) {
  const [sheet, setSheet] = useState<"not-now" | "else" | null>(null);
  // Something else opened by a stop-to-switch has no opener left (the Switch to button went with the
  // session), so focus lands on the dialog itself and returns to Start, not to <body>.
  const [openedBySwitch, setOpenedBySwitch] = useState(false);
  const returnFocusToStart = useRef(false);
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (sheet === null && returnFocusToStart.current) {
      returnFocusToStart.current = false;
      startRef.current?.focus();
    }
  }, [sheet]);
  const closeElse = () => {
    if (openedBySwitch) {
      returnFocusToStart.current = true;
      setOpenedBySwitch(false);
    }
    setSheet(null);
  };
  // Something else opens as the request arrives (state adjusted while rendering, not in an effect), and
  // the page is told so the request is spent.
  const [elseRequested, setElseRequested] = useState(false);
  if (Boolean(openElse) !== elseRequested) {
    setElseRequested(Boolean(openElse));
    if (openElse) {
      setOpenedBySwitch(true);
      setSheet("else");
    }
  }
  useEffect(() => {
    if (openElse) onElseOpened?.();
  }, [openElse, onElseOpened]);
  const now = useNow("minute");
  const [earlier, setEarlier] = useState<StartedEarlierChoice | null>(null);
  // "Started earlier?" belongs to the task it was chosen for: a replan that changes the primary drops it.
  const [earlierFor, setEarlierFor] = useState(primary.action.id);
  if (earlierFor !== primary.action.id) {
    setEarlierFor(primary.action.id);
    setEarlier(null);
  }
  const startedAt = startedAtFor(earlier, now, timezone);
  const earlierProblem = startedEarlierProblem(earlier, now, timezone, startFloor);
  const wallClock = primary.recommendedWallClockMinutes ?? null;
  const tierLabel = criticalTierLabel(primary.criticalTier);
  const reasons = whyThisNow({
    plain: plainWhySentence({
      deadline: primary.action.deadlineAt ?? forecast?.internalDeadlineAt,
      approximate: !primary.action.deadlineAt,
      minutes: primary.recommendedMinutes,
      now,
      timezone
    }),
    plannedEnd,
    nextCommitment,
    forecast,
    timezone
  });

  function startDirected(startedAt?: string) {
    if (!deliverableDirective) return;
    void runActivityCommand({
      commandId: createClientId(),
      expectedVersion: directedDeliverable?.version ?? null,
      type: "start_activity",
      targetType: "deliverable",
      targetId: deliverableDirective.targetId,
      plannedMinutes: deliverableDirective.recommendedMinutes,
      ...(startedAt ? { startedAt } : {}),
      // The engine names the deliverable; the session opens on its next executable step so time is
      // credited to a step from the first minute rather than to nothing.
      ...(directedDeliverable?.startStepId ? { stepId: directedDeliverable.startStepId } : {})
    })
      .then(() => {
        window.location.href = `/deliverables?deliverable=${encodeURIComponent(deliverableDirective.targetId)}`;
      })
      // The failure is already on the provider's banner; do not also leave it unhandled.
      .catch(() => undefined);
  }

  if (finished)
    return (
      <p className={styles.notice} role="status">
        Finding the next thing…
      </p>
    );

  return (
    <>
      {tierLabel && (
        <p className={styles.tier}>
          <Badge tone={tierTone(primary.criticalTier)}>{tierLabel}</Badge>
        </p>
      )}
      <div className={cx("actions", styles.actions)}>
        <Button
          ref={startRef}
          variant="primary"
          size="lg"
          className={styles.start}
          disabled={
            saving ||
            !planningDecisionCurrent ||
            (deliverableDirective !== null && !directedDeliverable) ||
            earlierProblem !== null
          }
          onClick={() => (deliverableDirective ? startDirected(startedAt) : onStartCurrent(startedAt))}
        >
          {startLabel(startedAt, timezone)}
        </Button>
        {planningDecisionCurrent || !onRefreshPlan || planRefresh !== "current" ? null : (
          <Button variant="secondary" size="lg" disabled={saving} onClick={onRefreshPlan}>
            Refresh the plan
          </Button>
        )}
        <Button variant="secondary" size="lg" disabled={saving} onClick={() => setSheet("not-now")}>
          Not now
        </Button>
        <Button variant="ghost" size="lg" aria-haspopup="dialog" onClick={() => setSheet("else")}>
          Something else…
        </Button>
        {planningDecisionCurrent ? null : (
          <p className={styles.notice} role="status">
            {planRefreshNotice(planRefresh)} Capture stays available.
          </p>
        )}
      </div>
      <StartedEarlier choice={earlier} onChange={setEarlier} now={now} timezone={timezone} floor={startFloor} />
      <div className={styles.why}>
        <p className={styles.label}>Why this, now</p>
        <ul className={styles.whyList}>
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
        <details className={styles.workings}>
          <summary>How this was worked out</summary>
          <p>
            For {primary.recommendedMinutes} focused minutes
            {wallClock !== null && wallClock !== primary.recommendedMinutes ? ` (${wallClock} by the clock)` : ""}, then
            check in.
          </p>
          {explanation ? <p>{localiseReason(explanation, timezone)}</p> : null}
          <ul>
            {evidence.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          {why?.whyNot && (
            <p>
              <strong>Why not {why.whyNot.title}?</strong> {why.whyNot.reason}{" "}
              <small>
                ({why.whyNot.tierLabel.toLowerCase()}; decided by {why.whyNot.decidingFactor.replace(/_/g, " ")})
              </small>
            </p>
          )}
          {why && why.wouldChangeIf.length > 0 && (
            <>
              <p>
                <strong>Would change if</strong>
              </p>
              <ul>
                {why.wouldChangeIf.map((item) => (
                  <li key={item.condition}>
                    {item.description}:{" "}
                    {item.thenPrimary
                      ? `${item.thenPrimary.title} for ${item.thenPrimary.recommendedMinutes} minutes`
                      : "nothing would lead"}
                  </li>
                ))}
              </ul>
            </>
          )}
          <div className={styles.score}>
            {Object.entries(primary.scoreComponents).map(([name, value]) => (
              <span key={name}>
                <strong>{formatScore(value)}</strong> {name.replace(/([A-Z])/g, " $1").toLowerCase()}
              </span>
            ))}
          </div>
        </details>
      </div>

      <Sheet open={sheet === "not-now"} onClose={() => setSheet(null)} title="Why not now?">
        <div className={styles.sheetBody}>
          <p className={styles.sheetSub}>
            {saving
              ? "Saving your last change; these come back in a moment."
              : snoozeRecommended && canSnooze(primary.action)
                ? "Put it off until later, or say what is in the way."
                : "It comes off the list until you say it can go ahead."}
          </p>
          {snoozeRecommended ? (
            <SnoozePicker
              action={snoozeTarget(primary.action, projects)}
              timezone={timezone}
              now={now}
              disabled={saving}
              onSnooze={snoozeRecommended}
              onDone={() => setSheet(null)}
            />
          ) : null}
          {snoozeRecommended && canSnooze(primary.action) ? (
            <h3 className={styles.sheetHeading}>Blocked by something</h3>
          ) : null}
          <Card className={styles.answers}>
            <List>
              {BLOCKING_REASONS.map((reason) => (
                <ListRow
                  key={reason.value}
                  title={reason.label}
                  disabled={saving}
                  onClick={() => {
                    setSheet(null);
                    void blockRecommended(reason.value as BlockingReason);
                  }}
                />
              ))}
            </List>
          </Card>
          {snoozeRecommended && canSnooze(primary.action) ? (
            <p className={styles.sheetSub}>A reason takes it off the list until you say it can go ahead.</p>
          ) : null}
        </div>
      </Sheet>

      <Sheet open={sheet === "else"} onClose={closeElse} title="Something else" focusDialog={openedBySwitch}>
        <div className={styles.sheetBody}>
          {alternatives.length ? (
            <>
              {saving || !planningDecisionCurrent ? (
                <p className={styles.sheetSub} role="status">
                  {saving
                    ? "Saving your last change; switching comes back in a moment."
                    : planRefreshNotice(planRefresh, "switching")}
                </p>
              ) : null}
              <div className={styles.field}>
                <span>Why switch?</span>
                <div className={styles.chips} role="group" aria-label="Why switch?">
                  {OVERRIDE_REASONS.map((reason) => (
                    <Chip
                      key={reason.value}
                      pressed={overrideReason === reason.value}
                      onClick={() => onOverrideReasonChange(reason.value)}
                    >
                      {reason.label}
                    </Chip>
                  ))}
                </div>
              </div>
              <Card className={styles.answers}>
                <List>
                  {alternatives.map((item) => (
                    <ListRow
                      key={item.action.id}
                      title={item.action.title}
                      meta={`${item.recommendedMinutes} min · fits now`}
                      disabled={saving || !planningDecisionCurrent || !item.recommendedMinutes}
                      onClick={() => {
                        closeElse();
                        void startAlternative(
                          item.action.id,
                          item.recommendedMinutes ?? item.action.minimumSessionMinutes,
                          overrideReason
                        );
                      }}
                    />
                  ))}
                </List>
              </Card>
            </>
          ) : (
            <p className={styles.sheetSub} role="status">
              {saving || !planningDecisionCurrent || planPending
                ? "Working out what fits…"
                : "Nothing else on the list fits right now."}
            </p>
          )}
          <Card className={styles.answers}>
            <List>
              <ListRow
                title="Something came up"
                meta="Tell the plan what changed"
                onClick={() => {
                  closeElse();
                  openCaptureSheet("disruption");
                }}
              />
              {extraChoices?.map((choice) => (
                <ListRow
                  key={choice.label}
                  title={choice.label}
                  meta={choice.meta}
                  onClick={() => {
                    closeElse();
                    choice.onChoose();
                  }}
                />
              ))}
            </List>
          </Card>
        </div>
      </Sheet>
    </>
  );
}

/** Plain sentences for "Why this, now": one plain line first, then whether it fits and how the area is doing. */
function whyThisNow({
  plain,
  plannedEnd,
  nextCommitment,
  forecast,
  timezone
}: {
  plain: string;
  plannedEnd: Date;
  nextCommitment: StoredCommitment | undefined;
  forecast: NowForecast | undefined;
  timezone: string;
}): string[] {
  const reasons = [plain];
  if (nextCommitment) {
    const startsAt = new Date(nextCommitment.startsAt);
    const spare = Math.round((startsAt.getTime() - plannedEnd.getTime()) / 60_000);
    reasons.push(
      spare >= 0
        ? `It fits before ${nextCommitment.title} at ${clock(startsAt, timezone)}${spare > 0 ? `, with ${hoursMinutes(spare)} to spare` : ""}.`
        : `${nextCommitment.title} starts at ${clock(startsAt, timezone)}.`
    );
  }
  if (forecast) {
    const health = healthChipText(forecast);
    const margin = forecast.expectedMarginMinutes;
    reasons.push(
      health === "not forecast"
        ? "This area has no forecast yet."
        : `This area is ${health}${margin != null ? (margin >= 0 ? `, with ${hoursMinutes(margin)} of slack in the plan` : `, ${hoursMinutes(-margin)} short in the plan`) : ""}.`
    );
  } else {
    reasons.push("This area has no forecast yet.");
  }
  return reasons;
}

/** What the disabled Start says: honest about whether the plan is on its way, retrying, or stuck. */
function planRefreshNotice(refresh: PlanRefreshState | undefined, what: "Start" | "switching" = "Start") {
  const What = what === "Start" ? "Start" : "Switching";
  if (refresh === "stalled") return `The plan is not refreshing, so ${what} is off until the planning worker recovers.`;
  if (refresh === "retrying") return `The plan refresh failed and will retry; ${what} returns once it lands.`;
  if (refresh === "refreshing") return `Updating the plan; ${what} returns the moment it lands.`;
  return `${What} is unavailable until the plan refreshes.`;
}
