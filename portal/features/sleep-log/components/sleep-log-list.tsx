"use client";

import { useState } from "react";
import type { StoredSleepPlan } from "@/state/portal-state";
import { deleteNight } from "@/features/sleep-log/sleep-log-command";
import { durationLabel, effectiveDurationMinutes, nightLabel } from "@/features/sleep-log/sleep-log-format";
import { useNow } from "@/shared/clock";
import { SleepNightSheet } from "./sleep-night-sheet";

type SheetState = { mode: "create" } | { mode: "edit"; plan: StoredSleepPlan } | null;

/** The one badge a night ever wears: what it is, not what it was called internally. A planned night
 * is either tonight's plan, still ahead, or one whose time passed without the app seeing it. */
function badge(plan: StoredSleepPlan, now: number): { className: string; text: string } | null {
  if (plan.status === "sleeping") return { className: "phase-pill live", text: "Sleeping now" };
  if (plan.status === "completed")
    return plan.manual
      ? { className: "phase-pill closed", text: "Logged" }
      : { className: "phase-pill", text: "Tracked" };
  if (plan.status === "planned")
    return new Date(plan.plannedStartAt).getTime() > now
      ? { className: "phase-pill", text: "Planned" }
      : { className: "phase-pill closed", text: "Not recorded" };
  return null;
}

/**
 * Recent nights, newest first as `/api/sleep-log` returns them, plus the one trigger that opens the
 * sheet to log a night the app never saw. A night still being slept can have its start corrected but
 * not deleted or given a wake time — only Now's "I'm awake" closes it out — and only a completed
 * night can be removed at all.
 */
export function SleepLogList({
  plans,
  timezone,
  onChanged
}: {
  plans: StoredSleepPlan[];
  timezone: string;
  /** Called after any successful save or delete, so the page can refetch `/api/sleep-log`. */
  onChanged: () => void | Promise<void>;
}) {
  const [sheet, setSheet] = useState<SheetState>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<{ id: string; message: string } | null>(null);
  const now = useNow("minute").getTime();

  async function confirmDelete(plan: StoredSleepPlan) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteNight(plan.id, plan.version ?? null);
      setConfirmingId(null);
      await onChanged();
    } catch (cause) {
      setDeleteError({ id: plan.id, message: cause instanceof Error ? cause.message : "The night was not removed." });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      {plans.length === 0 ? (
        <p className="empty">
          No nights recorded yet. Tracked sleep appears here automatically — add one you forgot below.
        </p>
      ) : (
        plans.map((plan) => {
          const chip = badge(plan, now);
          const start = plan.actualStartAt ?? plan.plannedStartAt;
          const wake = plan.actualWakeAt ?? plan.plannedWakeAt;
          const editable = plan.status === "sleeping" || plan.status === "completed";
          const deletable = plan.status === "completed";
          const confirming = confirmingId === plan.id;
          return (
            <article className="row-card" key={plan.id}>
              <div>
                <strong>
                  {nightLabel(start, timezone)}
                  {plan.status !== "sleeping" ? ` → ${nightLabel(wake, timezone)}` : ""}
                </strong>
                <p>{durationLabel(effectiveDurationMinutes(plan))}</p>
                {deleteError?.id === plan.id && (
                  <p className="form-error" role="alert">
                    {deleteError.message}
                  </p>
                )}
              </div>
              <div className="row-actions">
                {chip && <span className={chip.className}>{chip.text}</span>}
                {editable && (
                  <button type="button" className="quiet small" onClick={() => setSheet({ mode: "edit", plan })}>
                    Edit
                  </button>
                )}
                {deletable &&
                  (confirming ? (
                    <>
                      <span>Confirm delete?</span>
                      <button
                        type="button"
                        className="quiet small"
                        disabled={deleting}
                        onClick={() => void confirmDelete(plan)}
                      >
                        Yes, delete
                      </button>
                      <button type="button" className="quiet small" onClick={() => setConfirmingId(null)}>
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="quiet small danger"
                      onClick={() => {
                        setConfirmingId(plan.id);
                        setDeleteError(null);
                      }}
                    >
                      Delete
                    </button>
                  ))}
              </div>
            </article>
          );
        })
      )}
      <button type="button" className="quiet" onClick={() => setSheet({ mode: "create" })}>
        Add a night
      </button>
      <SleepNightSheet
        open={sheet !== null}
        plan={sheet?.mode === "edit" ? sheet.plan : null}
        timezone={timezone}
        onClose={() => setSheet(null)}
        onSaved={onChanged}
      />
    </>
  );
}
