"use client";

import type { StoredAction, StoredOccurrence, StoredRoutineStep } from "@/state/portal-state";
import { formatZonedTime } from "@/shared/date-format";

/** Recurring windows that resolve to the current local day, and whether a routine already covers them. */
export function OccurrencePanel({
  occurrences,
  actions,
  routineSteps,
  timezone
}: {
  occurrences: StoredOccurrence[];
  actions: StoredAction[];
  routineSteps: StoredRoutineStep[];
  timezone: string;
}) {
  const time = (value: string) => formatZonedTime(value, timezone);
  return (
    <>
      {occurrences.map((item) => {
        const action = actions.find((candidate) => candidate.id === item.actionId);
        // `routineCovered` is the engine's own verdict (a routine's linked window is one of
        // its `routine_steps` rows' `actionWindowId` now, not a `routine_instances` row's
        // `occurrenceIds`); the matching step is looked up only to name which one, for display.
        const coveringStep = item.routineCovered
          ? routineSteps.find((candidate) => candidate.actionWindowId === item.windowId)
          : undefined;
        return (
          <article className="row-card" key={item.id}>
            <div>
              <strong>
                {action?.title ?? "Recurring action"} · {item.windowName}
              </strong>
              <p>
                {time(item.windowStartsAt)}–{time(item.windowEndsAt)} · {item.anchorSource.replaceAll("_", " ")}
                {item.routineCovered ? ` · covered by ${coveringStep?.title ?? "a routine"}` : ""}
              </p>
            </div>
            <span
              className={`health ${item.status === "completed" ? "ahead" : item.status === "missed" ? "behind" : "on_track"}`}
            >
              {item.status}
            </span>
          </article>
        );
      })}
      {!occurrences.length && <p className="empty">No recurring windows fall on this day.</p>}
    </>
  );
}
