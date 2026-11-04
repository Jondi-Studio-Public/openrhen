"use client";

import { isClosedStatus } from "@openrhen/contracts";
import type { FormEvent } from "react";
import type { PortalState } from "@/state/portal-state";
import { DirectionPicker } from "./direction-picker";
import { Field } from "@/components/field";

/** Up to three desired wins, plus a recorded deferral so a dropped action leaves a reason behind. */
export function DirectionPanel({
  state,
  desiredWins,
  onDesiredWinsChange,
  deferredAction,
  onDeferredActionChange,
  deferredReason,
  onDeferredReasonChange,
  onSubmit
}: {
  state: PortalState;
  desiredWins: string[];
  onDesiredWinsChange: (actionIds: string[]) => void;
  deferredAction: string;
  onDeferredActionChange: (actionId: string) => void;
  deferredReason: string;
  onDeferredReasonChange: (reason: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <>
      <form className="editor-grid" onSubmit={onSubmit}>
        <div className="field wide">
          <span>Desired wins</span>
          <small>
            Choose up to three actions you especially want to advance today. Narrow to an area, outcome, or project
            first, or search across everything.
          </small>
          <DirectionPicker state={state} selected={desiredWins} onChange={onDesiredWinsChange} />
        </div>
        <Field label="Defer an action">
          <select value={deferredAction} onChange={(event) => onDeferredActionChange(event.target.value)}>
            <option value="">None</option>
            {state.projects.map((project) => {
              const items = state.actions.filter(
                (item) => item.status !== "done" && !isClosedStatus(item.status) && item.projectId === project.id
              );
              return items.length ? (
                <optgroup key={project.id} label={project.title}>
                  {items.map((action) => (
                    <option key={action.id} value={action.id}>
                      {action.title}
                    </option>
                  ))}
                </optgroup>
              ) : null;
            })}
            {state.actions
              .filter(
                (item) =>
                  item.status !== "done" &&
                  !isClosedStatus(item.status) &&
                  !state.projects.some((project) => project.id === item.projectId)
              )
              .map((action) => (
                <option key={action.id} value={action.id}>
                  {action.title}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Deferral reason">
          <input value={deferredReason} onChange={(event) => onDeferredReasonChange(event.target.value)} />
        </Field>
        <button type="submit">Save today’s direction</button>
      </form>
      {state.dailyPlan?.deferredItems.map((item) => (
        <p className="microcopy" key={`${item.actionId}:${item.reason}`}>
          Deferred: {state.actions.find((action) => action.id === item.actionId)?.title ?? "Unknown action"} ·{" "}
          {item.reason}
        </p>
      ))}
    </>
  );
}
