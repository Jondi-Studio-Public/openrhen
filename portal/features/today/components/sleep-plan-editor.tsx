"use client";

import { useState, type FormEvent } from "react";
import type { PlanningEntityCommand } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { formatZonedDateTime } from "@/shared/date-format";
import { dateInput } from "@/features/today/local-datetime";
import { sleepPlanOverrideCommand, sleepPlanPlacementChoiceCommand } from "@/features/today/today-commands";
import { Field } from "@/components/field";
import { TodayFormHost } from "./today-form-host";

/**
 * The seven planned nights, each with the reason it looks the way it does and every hard error the
 * planner attached, so a night that cannot meet the minimum says so instead of quietly shrinking.
 * The one-night override form opens in a sheet on a phone and inline on a desk. Correcting a night
 * already slept — or logging one the planner never saw — is a different job and lives at `/sleep`;
 * this panel only points there.
 */
export function SleepPlanEditor({
  state,
  saveEntityCommand,
  phone = false
}: {
  state: PortalState;
  saveEntityCommand: (command: PlanningEntityCommand) => Promise<void>;
  phone?: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const plan = state.sleepPlans.find((item) => item.id === editing);
  const [start, setStart] = useState("");
  const [wake, setWake] = useState("");
  const planned = state.sleepPlans.filter((item) => item.status === "planned");
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!plan) return;
    await saveEntityCommand(sleepPlanOverrideCommand(plan, start, wake, state.settings.timezone));
    setEditing(null);
  }
  return (
    <>
      {!state.settings.lastWokeAt && (
        <p className="form-warning">Add when you last woke in Settings before sleep can be planned safely.</p>
      )}
      {planned.map((item) => {
        const tentative = state.commitments.find(
          (commitment) =>
            commitment.status === "tentative" &&
            new Date(commitment.startsAt) < new Date(item.plannedWakeAt) &&
            new Date(commitment.endsAt) > new Date(item.plannedStartAt)
        );
        return (
          <article className="row-card" key={item.id}>
            <div>
              <strong>
                {formatZonedDateTime(item.plannedStartAt, state.settings.timezone)} →{" "}
                {formatZonedDateTime(item.plannedWakeAt, state.settings.timezone)}
              </strong>
              <p>
                {Math.round(item.allowedMinutes / 6) / 10}h planned
                {item.targetMinutes && item.targetMinutes !== item.allowedMinutes
                  ? ` of ${Math.round(item.targetMinutes / 6) / 10}h target`
                  : ""}{" "}
                · {item.explanation}
              </p>
              {item.minimumShortfallMinutes ? (
                <span className="form-warning">
                  Minimum sleep cannot be met: {item.minimumShortfallMinutes} minutes short because of{" "}
                  {item.wakeConstraint?.title ?? "a confirmed commitment"}.
                </span>
              ) : null}
              {tentative ? (
                <span className="form-warning">
                  Tentative commitment “{tentative.title}” conflicts with protected sleep and does not shorten it.
                </span>
              ) : null}
              {item.hardErrors
                .filter((error) => !error.startsWith("Minimum sleep cannot be met"))
                .map((error) => (
                  <span className="form-warning" key={error}>
                    {error}
                  </span>
                ))}
              {item.deviationOptions?.warn ? (
                <>
                  <span className="form-warning">
                    This night starts well before your usual bedtime: bed at{" "}
                    {formatZonedDateTime(item.deviationOptions.early.startsAt, state.settings.timezone)} for{" "}
                    {Math.round((item.deviationOptions.early.minutes / 60) * 10) / 10}h, or keep{" "}
                    {formatZonedDateTime(item.deviationOptions.near.startsAt, state.settings.timezone)} →{" "}
                    {formatZonedDateTime(item.deviationOptions.near.wakesAt, state.settings.timezone)} for{" "}
                    {Math.round((item.deviationOptions.near.minutes / 60) * 10) / 10}h.
                  </span>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="quiet small"
                      onClick={() => void saveEntityCommand(sleepPlanPlacementChoiceCommand(item, "early"))}
                    >
                      Go to bed early
                    </button>
                    <button
                      type="button"
                      className="quiet small"
                      onClick={() => void saveEntityCommand(sleepPlanPlacementChoiceCommand(item, "near"))}
                    >
                      Keep this night
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            <button
              className="quiet small"
              onClick={() => {
                setEditing(item.id);
                setStart(dateInput(item.plannedStartAt, state.settings.timezone));
                setWake(dateInput(item.plannedWakeAt, state.settings.timezone));
              }}
            >
              Edit night
            </button>
          </article>
        );
      })}
      <TodayFormHost phone={phone} open={Boolean(plan)} title="Edit night" onClose={() => setEditing(null)}>
        {plan && (
          <form className="editor-grid" onSubmit={save}>
            <Field label="Sleep starts">
              <input type="datetime-local" value={start} onChange={(event) => setStart(event.target.value)} />
            </Field>
            <Field label="Wake time">
              <input type="datetime-local" value={wake} onChange={(event) => setWake(event.target.value)} />
            </Field>
            <p className="microcopy wide">
              One-night overrides cannot cross your minimum-sleep or maximum-awake rules.
            </p>
            <div className="form-actions">
              <button>Save override</button>
              <button type="button" className="quiet" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        )}
      </TodayFormHost>
      <p className="microcopy">
        <a href="/sleep">Correct a past night</a>
      </p>
    </>
  );
}
