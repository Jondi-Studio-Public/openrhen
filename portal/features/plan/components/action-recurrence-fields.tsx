"use client";

import type { ActionDraft } from "@/features/plan/plan-drafts";
import { Field } from "@/components/field";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The extra questions a repeating action raises: when the series runs, what ends it, and — for a
 * recurrence — the clock times to fall back to on a day where wake and sleep are not known. A
 * cadence has no windows, only how many days apart it is suggested.
 */
export function ActionRecurrenceFields({
  draft,
  onChange,
  mode = "recurring"
}: {
  draft: ActionDraft;
  onChange: (draft: ActionDraft) => void;
  mode?: "recurring" | "cadence";
}) {
  return (
    <>
      {mode === "cadence" && (
        <Field label="Suggest">
          <select
            value={draft.periodUnit ?? "interval"}
            onChange={(event) =>
              onChange({ ...draft, periodUnit: event.target.value as "interval" | "days" | "month" })
            }
          >
            <option value="interval">Every N days (a plain interval)</option>
            <option value="days">A number of times within each block of days (counted from the series start)</option>
            <option value="month">A number of times within the calendar month</option>
          </select>
        </Field>
      )}
      {mode === "cadence" && (draft.periodUnit ?? "interval") === "interval" && (
        <Field label="Suggest every">
          <div className="time-pair">
            <input
              aria-label="Days between suggestions"
              type="number"
              min="1"
              step="1"
              value={draft.intervalDays ?? "1"}
              onChange={(event) => onChange({ ...draft, intervalDays: event.target.value })}
            />
            <span>{Number(draft.intervalDays) === 1 ? "day" : "days"}</span>
          </div>
          <small>
            Offered after deadline-driven work when time allows, pressing harder the longer it goes undone; once done it
            waits until tomorrow.
          </small>
        </Field>
      )}
      {mode === "cadence" && draft.periodUnit === "days" && (
        <Field label="Period length">
          <div className="time-pair">
            <input
              aria-label="Period length in days"
              type="number"
              min="1"
              step="1"
              value={draft.periodLength ?? "7"}
              onChange={(event) => onChange({ ...draft, periodLength: event.target.value })}
            />
            <span>days</span>
          </div>
        </Field>
      )}
      {mode === "cadence" && draft.periodUnit && draft.periodUnit !== "interval" && (
        <>
          <Field label="Times per period">
            <input
              aria-label="Target occurrences per period"
              type="number"
              min="1"
              step="1"
              value={draft.targetOccurrences ?? "1"}
              onChange={(event) => onChange({ ...draft, targetOccurrences: event.target.value })}
            />
            <small>
              The planner picks which days; pressure rises as the period runs out with occurrences still wanted.
            </small>
          </Field>
          <Field label="Minimum days apart">
            <input
              aria-label="Minimum days between completions"
              type="number"
              min="0"
              step="1"
              value={draft.minSpacingDays ?? ""}
              onChange={(event) => onChange({ ...draft, minSpacingDays: event.target.value })}
            />
            <small>Optional — leave blank for no floor between two completions.</small>
          </Field>
          <Field label="Eligible weekdays">
            <div className="weekday-row">
              {WEEKDAY_LABELS.map((label, weekday) => {
                const checked = (draft.eligibleWeekdays ?? []).includes(weekday);
                return (
                  <label key={weekday}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => {
                        const current = draft.eligibleWeekdays ?? [];
                        const next = event.target.checked
                          ? [...current, weekday]
                          : current.filter((day) => day !== weekday);
                        onChange({ ...draft, eligibleWeekdays: next });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
            <small>Leave every box unchecked to allow any day.</small>
          </Field>
        </>
      )}
      <Field label="Series starts">
        <input
          type="date"
          value={draft.recurrenceStart}
          onChange={(event) => onChange({ ...draft, recurrenceStart: event.target.value })}
        />
      </Field>
      <Field label="Ends when">
        <select
          value={draft.completionMode ?? "end_date"}
          onChange={(event) =>
            onChange({
              ...draft,
              completionMode: event.target.value as "end_date" | "total_minutes" | "manual"
            })
          }
        >
          <option value="end_date">A calendar date is reached</option>
          <option value="total_minutes">A total time goal is reached</option>
          <option value="manual">Marked complete manually</option>
        </select>
      </Field>
      {(draft.completionMode ?? "end_date") === "end_date" && (
        <Field label="Series ends">
          <input
            type="date"
            value={draft.recurrenceEnd}
            onChange={(event) => onChange({ ...draft, recurrenceEnd: event.target.value })}
          />
        </Field>
      )}
      {draft.completionMode === "total_minutes" && (
        <Field label="Target total minutes">
          <input
            type="number"
            min="1"
            value={draft.targetTotalMinutes ?? ""}
            onChange={(event) => onChange({ ...draft, targetTotalMinutes: event.target.value })}
          />
        </Field>
      )}
      {draft.completionMode === "manual" && (
        <Field label="Ends">
          <span className="microcopy">Keeps recurring until marked complete from the action list.</span>
        </Field>
      )}
      {mode === "recurring" && (
        <>
          <Field label="Morning fallback">
            <div className="time-pair">
              <input
                aria-label="Morning fallback start"
                type="time"
                value={draft.morningFallbackStart}
                onChange={(event) => onChange({ ...draft, morningFallbackStart: event.target.value })}
              />
              <span>to</span>
              <input
                aria-label="Morning fallback end"
                type="time"
                value={draft.morningFallbackEnd}
                onChange={(event) => onChange({ ...draft, morningFallbackEnd: event.target.value })}
              />
            </div>
            <small>Primary window is wake through wake +3 hours.</small>
          </Field>
          <Field label="Bedtime fallback">
            <div className="time-pair">
              <input
                aria-label="Bedtime fallback start"
                type="time"
                value={draft.bedtimeFallbackStart}
                onChange={(event) => onChange({ ...draft, bedtimeFallbackStart: event.target.value })}
              />
              <span>to</span>
              <input
                aria-label="Bedtime fallback end"
                type="time"
                value={draft.bedtimeFallbackEnd}
                onChange={(event) => onChange({ ...draft, bedtimeFallbackEnd: event.target.value })}
              />
            </div>
            <small>
              Primary window is the three hours before planned sleep; a linked routine reserves the exact occurrence
              duration.
            </small>
          </Field>
        </>
      )}
    </>
  );
}
