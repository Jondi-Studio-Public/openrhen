"use client";

import { useState } from "react";
import type { PlanningEntityCommand, TransportMode } from "@openrhen/contracts";
import type { DayPlanItem, DayPlanUntimed, DayPlanWait } from "@/features/today/day-plan";
import type { PortalState, StoredProject } from "@/state/portal-state";
import type { ClientForecast } from "@/state/portal-provider";
import { travelSourceLabel } from "@/features/now/now-formatting";
import { formatZonedTime } from "@/shared/date-format";
import { Sheet } from "@/components/sheet";
import { endDisruptionNow, extendDisruption, isOpenEndedDisruption } from "@/features/disruptions/disruption-commands";
import { latestSafeStartText } from "@/features/plan/latest-safe-start";
import { formatDeadline } from "./day-timeline";
import { snoozeTarget } from "@/features/now/snooze";
import { SnoozePicker } from "@/features/now/components/snooze-picker";

/** Kinds whose target may be an action, and so may carry a "Latest safe start" line. */
const SAFE_START_KINDS = new Set<DayPlanItem["kind"]>(["directive", "planned", "reserved", "soft"]);

const MODE_LABEL: Record<TransportMode, string> = { car: "by car", bike: "by bike", walk: "on foot" };

/**
 * A read-only look at something the engine put on the day: what it is, how long, why it sits where
 * it does, and where to act on it. The plan itself stays the engine's to change.
 *
 * The one thing recorded from here is a preparation step being ticked off, which is not an exception
 * to that: ticking tomorrow morning's prep the night before is carrying the day out, not shaping it,
 * and it is the only reason the Preparation panel had to be reachable from Today at all.
 */
export function DayPlanDetailSheet({
  item,
  chip,
  wait = null,
  timezone,
  projects,
  state,
  now,
  forecasts = [],
  detailedEndsAt = null,
  saveEntityCommand,
  onClose,
  onMarkDone,
  onSnooze
}: {
  item: DayPlanItem | null;
  chip: DayPlanUntimed | null;
  /** A waits-strip entry tapped in place of a block; read-only, same as everything else here. */
  wait?: DayPlanWait | null;
  timezone: string;
  projects: StoredProject[];
  /** Read to resolve a commitment block back to its stored record, for the disruption lifecycle below. */
  state: PortalState;
  now: Date;
  /** For "Latest safe start", one per project — see `latestSafeStartText`. */
  forecasts?: ClientForecast[];
  /** The "detailed" capacity envelope's own `endsAt`, for `latestSafeStartText`. */
  detailedEndsAt?: Date | null;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
  onClose: () => void;
  /** Records a preparation step as done. Absent when the host cannot save, which hides the action. */
  onMarkDone?: ((item: DayPlanItem) => Promise<void>) | undefined;
  /** Puts the block's action off until an instant, without blocking it. Absent hides the snooze choices. */
  onSnooze?: ((actionId: string, availableFrom: string) => Promise<void>) | undefined;
}) {
  const open = Boolean(item || chip || wait);
  const time = (value: Date) => formatZonedTime(value, timezone);
  const project = item?.parentId ? projects.find((candidate) => candidate.id === item.parentId) : undefined;
  // A directive/planned/reserved/soft block's `entityId` is an action id; find the project's own
  // forecast to read its `latestSafeStarts` from, and say nothing when the target is not an action
  // the forecast knows (a recovery placeholder, say) rather than guessing.
  const safeStart =
    item && SAFE_START_KINDS.has(item.kind)
      ? latestSafeStartText({
          forecast: forecasts.find(
            (candidate) =>
              candidate.projectId === state.actions.find((action) => action.id === item.entityId)?.projectId
          ),
          unitId: item.entityId,
          detailedEndsAt,
          timeZone: timezone
        })
      : null;
  // A commitment block only carries its `entityId`; the disruption lifecycle needs the stored record
  // itself, so it is resolved here the same way `today/page.tsx` resolves it before opening the sheet.
  const commitment =
    item?.kind === "commitment" ? state.commitments.find((candidate) => candidate.id === item.entityId) : undefined;
  // Only work the engine placed for an action can be put off from here; a reservation protects a
  // deadline and a cadence slot is cosmetic.
  const snoozeAction =
    item && (item.kind === "directive" || item.kind === "planned")
      ? state.actions.find((candidate) => candidate.id === item.entityId)
      : undefined;
  const openEndedDisruption = Boolean(commitment && isOpenEndedDisruption(commitment));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // One sheet serves every block on the day, so a confirmation left standing from the last one is a
  // confirmation aimed at the wrong step. Each new block arrives with it cleared.
  const blockKey = `${item?.id ?? ""}|${chip?.id ?? ""}`;
  const [shownBlockKey, setShownBlockKey] = useState(blockKey);
  if (shownBlockKey !== blockKey) {
    setShownBlockKey(blockKey);
    setConfirming(false);
    setSaving(false);
    setError("");
  }

  async function markDone() {
    if (!item || !onMarkDone) return;
    setSaving(true);
    try {
      await onMarkDone(item);
      setError("");
      // A completed step leaves the day's canvas, so leaving the sheet open would hold a block that
      // is no longer on the plan behind it.
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Routine step was not saved.");
    } finally {
      setSaving(false);
    }
  }

  async function endNow() {
    if (!commitment) return;
    setSaving(true);
    setError(await endDisruptionNow(commitment, { state, now, saveEntityCommand }));
    setSaving(false);
  }

  async function extendHour() {
    if (!commitment) return;
    setSaving(true);
    setError(await extendDisruption(commitment, 60, { state, now, saveEntityCommand }));
    setSaving(false);
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={
        wait && !item
          ? "Waiting on a step"
          : item?.kind === "travel"
            ? item.projected
              ? "A journey the projected day makes"
              : "The journey to make now"
            : item?.kind === "reserved"
              ? "Latest-safe reservation"
              : item?.kind === "soft"
                ? "Room for a cadence action"
                : item?.kind === "leave_by"
                  ? "When to leave"
                  : item?.kind === "start_by"
                    ? "When to start"
                    : item?.kind === "planned"
                      ? "Projected"
                      : // Blocks with no editor of their own open here, so they are named for what
                        // they are rather than as an engine placement.
                        item?.kind === "commitment"
                        ? "A fixed commitment"
                        : item?.kind === "routine_step"
                          ? "A preparation step"
                          : "Planned for you"
      }
    >
      {item && (
        <div className="day-plan-detail">
          <h3>{item.title}</h3>
          <dl>
            {item.marker ? (
              <>
                <dt>When</dt>
                <dd>{time(item.startsAt)}</dd>
              </>
            ) : (
              <>
                <dt>Window</dt>
                <dd>
                  {time(item.startsAt)}–{time(item.endsAt)}
                </dd>
              </>
            )}
            {item.minutes !== undefined && (
              <>
                <dt>Minutes</dt>
                <dd>
                  {item.wallMinutes !== undefined && item.wallMinutes !== item.minutes
                    ? `${item.minutes} focused over ${item.wallMinutes}`
                    : item.minutes}
                </dd>
              </>
            )}
            {item.kind === "travel" && (
              <>
                <dt>Leave by</dt>
                <dd>{time(item.startsAt)}</dd>
                <dt>Leg</dt>
                <dd>{item.title}</dd>
                <dt>How</dt>
                <dd>{item.mode ? MODE_LABEL[item.mode] : "however you get there"}</dd>
                <dt>Estimate</dt>
                <dd>{item.travelSource ? travelSourceLabel(item.travelSource) : "not stated for a projected leg"}</dd>
                <dt>For</dt>
                <dd>{item.thenTitle ?? "nothing in particular; the leg is the plan"}</dd>
              </>
            )}
            {item.deadlineAt && (
              <>
                <dt>Protects</dt>
                <dd>deadline {formatDeadline(item.deadlineAt, timezone)}</dd>
              </>
            )}
            {project && (
              <>
                <dt>Project</dt>
                <dd>{project.title}</dd>
              </>
            )}
            {item.tier && (
              <>
                <dt>Tier</dt>
                <dd>{item.tier}</dd>
              </>
            )}
            {(item.reason ?? item.subtitle) && (
              <>
                <dt>Why</dt>
                <dd>{item.reason ?? item.subtitle}</dd>
              </>
            )}
            {safeStart && safeStart.kind !== "none" && (
              <>
                <dt>Latest safe start</dt>
                <dd>{safeStart.text}</dd>
              </>
            )}
          </dl>
          {item.steps && item.steps.length > 0 && (
            // Where a folded run says what it folded. The block itself only has room for its name and
            // a count once it is short enough to need folding at all, so the members are listed here.
            <ol className="day-plan-detail-steps" aria-label="Steps in this block">
              {item.steps.map((step) => (
                <li key={step.id}>
                  {step.title} · {time(step.startsAt)}
                </li>
              ))}
            </ol>
          )}
          <p className="microcopy">
            {item.kind === "travel"
              ? "Travel is additive: setup, then the journey, then a couple of minutes to arrive, then the commitment. Arriving is recorded on Now — saying you are there is the whole of it — and cannot be done from here."
              : item.kind === "reserved"
                ? "The engine allocates backward from the deadline to prove the work still fits. This is feasibility evidence, not an appointment."
                : item.kind === "next_fit"
                  ? "The first thing that fits once the current boundary passes, at the time the engine found for it."
                  : item.kind === "routine_step"
                    ? "Preparation the planner placed against its commitment. Ticking it here records it as done; what the step is, and where its routine came from, are the commitment's own page."
                    : item.kind === "soft"
                      ? "A cadence action, not held for anyone: the room shown is one of the slots it could still fit this week, cosmetic only, and never taken from a real allocation."
                      : item.kind === "leave_by"
                        ? "When you need to leave to make this commitment, from the current travel estimate. It moves if the estimate does."
                        : item.kind === "start_by"
                          ? "The latest this preparation step can start and still finish before its window closes."
                          : item.projected
                            ? "A projection from the current recommendation; it will move if the day goes differently."
                            : "What to do right now, shown for its full length on the clock. The rest of the day after it is a projection."}
            {item.displaced
              ? " The projected day does not reach this before its latest safe start; the reservation that protects the deadline is untouched."
              : ""}
            {item.stale ? " This came from a plan that is no longer current." : ""}
          </p>
          {openEndedDisruption && commitment && (
            <p className="microcopy">
              This is held open until {time(new Date(commitment.endsAt))} — a guess, not a fact. Say when it's over and
              the plan rebuilds.
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {snoozeAction && onSnooze ? (
            <div className="day-plan-snooze">
              <h4>Not today?</h4>
              <SnoozePicker
                action={snoozeTarget(snoozeAction, projects)}
                timezone={timezone}
                now={now}
                onSnooze={(availableFrom) => onSnooze(snoozeAction.id, availableFrom)}
                onDone={onClose}
              />
            </div>
          ) : null}
          <div className="form-actions">
            {openEndedDisruption ? (
              <>
                <button type="button" className="quiet small" disabled={saving} onClick={() => void endNow()}>
                  Done, heading home
                </button>
                <button type="button" className="quiet small" disabled={saving} onClick={() => void extendHour()}>
                  Still out — another hour
                </button>
              </>
            ) : null}
            {item.kind === "routine_step" && onMarkDone ? (
              confirming ? (
                // The same gate the Preparation panel put on it: two identical steps sit a day apart
                // on this canvas, and a mis-tap that silently completed one of them left no trace.
                <>
                  <span>Confirm mark as done?</span>
                  <button type="button" className="quiet small" disabled={saving} onClick={() => void markDone()}>
                    Yes, mark as done
                  </button>
                  <button type="button" className="quiet small" onClick={() => setConfirming(false)}>
                    No
                  </button>
                </>
              ) : (
                <button type="button" className="quiet small" onClick={() => setConfirming(true)}>
                  Mark as done
                </button>
              )
            ) : null}
            {item.kind === "routine_step" && item.parentId ? (
              <a href={`/commitments/${encodeURIComponent(item.parentId)}`} className="button-link">
                Open commitment
              </a>
            ) : (
              <a href="/" className="button-link">
                {item.kind === "travel" ? "Open Now to arrive" : item.projected ? "Start now" : "Open Now"}
              </a>
            )}
            <a href="/plan" className="button-link quiet">
              Open Plan
            </a>
          </div>
        </div>
      )}
      {wait && !item && !chip && (
        <div className="day-plan-detail">
          <h3>{wait.title}</h3>
          <dl>
            <dt>Window</dt>
            <dd>
              {time(wait.startsAt)}–{time(wait.endsAt)}
            </dd>
            <dt>Status</dt>
            <dd>{wait.running ? "running now" : "projected"}</dd>
          </dl>
          <p className="microcopy">
            {wait.running
              ? "The step is done and its wait is running now; nothing to act on until it ends."
              : "A wait the projected day expects once its step is done; it will move if the day goes differently."}
            {wait.stale ? " This came from a plan that is no longer current." : ""}
          </p>
          <div className="form-actions">
            <a href="/" className="button-link">
              Open Now
            </a>
            <a href="/plan" className="button-link quiet">
              Open Plan
            </a>
          </div>
        </div>
      )}
      {chip && !item && (
        <div className="day-plan-detail">
          <h3>{chip.title}</h3>
          <dl>
            <dt>Minutes</dt>
            <dd>{chip.minutes}</dd>
            <dt>Why here</dt>
            <dd>{chip.reason}</dd>
          </dl>
          <p className="microcopy">
            Next in the engine’s ranking, not next on the clock. It has no start time until the engine names one.
          </p>
          <div className="form-actions">
            <a href="/" className="button-link">
              Open Now
            </a>
            <a href="/plan" className="button-link quiet">
              Open Plan
            </a>
          </div>
        </div>
      )}
    </Sheet>
  );
}
