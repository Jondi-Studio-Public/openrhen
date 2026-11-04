import { useSyncExternalStore } from "react";

/**
 * What this tab just recorded as a disruption: the command id that undoes it, and what it said, so the line on Now
 * can show it at once (the recorder moves the pulse to `on/disrupted` a moment later) and offer Undo beside End.
 * Kept for this tab only: after a reload the line still offers End (which needs nothing) but not Undo.
 */
export interface RecordedDisruption {
  commandId: string | null;
  doing: string;
  until: string;
}

let current: RecordedDisruption | null = null;
const listeners = new Set<() => void>();

export function rememberDisruption(recorded: RecordedDisruption | null) {
  current = recorded;
  for (const listener of listeners) listener();
}

export function useRecordedDisruption(): RecordedDisruption | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
    () => null
  );
}
