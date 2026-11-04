"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the Go to palette is open. The rail's search box, Ctrl K anywhere, and the row at the top
 * of You all open it, so like the capture sheet it is a tiny in-memory store rather than shell state
 * threaded through props.
 */
const listeners = new Set<() => void>();

let open = false;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot of the Set: a listener may unsubscribe while we iterate
  for (const listener of [...listeners]) listener();
}

export function openGoTo(): void {
  publish(true);
}

export function closeGoTo(): void {
  publish(false);
}

export function useGoToOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => open,
    () => false
  );
}
