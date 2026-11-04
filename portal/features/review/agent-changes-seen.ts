"use client";

import { useSyncExternalStore } from "react";

/**
 * When this device last showed the Agent changes list, so Now can say "3 agent changes since you
 * looked". Per device, like the welcome-back stamp: what the phone saw is not what the desk did.
 */
export const AGENT_CHANGES_LOOKED_KEY = "openrhen.agentChanges.lookedAt";

/** What this tab last wrote, read only when storage is blocked, so this visit still counts as looked. */
let written: string | null = null;
const listeners = new Set<() => void>();

/** The stamp as stored now, read outside React (the list reads it once, before marking). */
export function readAgentChangesLookedAt(): string | null {
  return read() ?? written;
}

function read(): string | null {
  try {
    return window.localStorage.getItem(AGENT_CHANGES_LOOKED_KEY);
  } catch {
    return null;
  }
}

/** Records now as the time the list was last looked at on this device. */
export function markAgentChangesLooked(at: Date = new Date()) {
  written = at.toISOString();
  try {
    window.localStorage.setItem(AGENT_CHANGES_LOOKED_KEY, written);
  } catch {
    // Storage blocked or full: the count just comes back next visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Null on the server and during hydration, and when this device never looked. */
export function useAgentChangesLookedAt(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => readAgentChangesLookedAt(),
    () => null
  );
}
