"use client";

import type { CanDoNowItem } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { clock } from "@/features/now/now-formatting";
import type { RunActivityCommand } from "@/features/now/now-model";
import { startCanDoNowStepCommand } from "@/features/now/can-do-now-commands";

/**
 * Every offerable flexible commitment before-step, less the current directive
 * already ordered by
 * `placedStartAt`. **Start** sends the same `start_activity` command a directed routine step's own
 * panel sends (`routine-step-panel.tsx`) — same target type, same expected version, read off the
 * matching stored row. Renders nothing when there are none.
 */
export function CanDoNowList({
  items,
  state,
  timezone,
  saving,
  runActivityCommand
}: {
  items: CanDoNowItem[];
  state: PortalState;
  timezone: string;
  saving: boolean;
  runActivityCommand: RunActivityCommand;
}) {
  if (!items.length) return null;
  return (
    <section className="can-do-now-list">
      <h2>Can do now</h2>
      <ul>
        {items.map((item) => (
          <li key={item.stepId}>
            <span className="title">{item.title}</span> <span className="minutes">{item.durationMinutes} min</span>
            {item.startBy && (
              <>
                {" "}
                <span className="start-by">start by {clock(new Date(item.startBy), timezone)}</span>
              </>
            )}{" "}
            <button
              type="button"
              disabled={saving}
              onClick={() => void runActivityCommand(startCanDoNowStepCommand(item, state))}
            >
              Start
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
