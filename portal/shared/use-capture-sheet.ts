"use client";

import { useSyncExternalStore } from "react";
import { CLOSED_CAPTURE_SHEET, type CaptureSheetMode, type CaptureSheetState } from "./capture-sheet";

/**
 * Whether the global `+` sheet is open, and for which half.
 *
 * The shell owns the sheet, but the things that open it are scattered — the rail, the tab bar, and a
 * button on Now that opens it straight into the disruption form — so the state is a tiny external
 * store rather than shell state threaded through props no intermediate component cares about. It is
 * in memory only: this is where the reader is right now, not a preference.
 *
 * `getServerSnapshot` returns the closed sheet, which is what the server rendered, so hydration
 * matches.
 */
const listeners = new Set<() => void>();

let current: CaptureSheetState = CLOSED_CAPTURE_SHEET;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function snapshot(): CaptureSheetState {
  return current;
}

function publish(next: CaptureSheetState): void {
  current = next;
  // oxlint-disable-next-line unicorn/no-useless-spread -- snapshot of the Set: a listener may unsubscribe while we iterate
  for (const listener of [...listeners]) listener();
}

/**
 * Opens the sheet on the named half; the `+` button always names "capture". `disruptionPreset` is
 * how a **Let someone know?** offer pre-chooses a contact on the disruption half
 * omitted, the sheet opens with no preset, as it always did.
 */
export function openCaptureSheet(
  mode: CaptureSheetMode = "capture",
  disruptionPreset?: CaptureSheetState["disruptionPreset"]
): void {
  publish({ open: true, mode, ...(disruptionPreset ? { disruptionPreset } : {}) });
}

/** The segmented control inside the sheet, which switches halves without reopening it. */
export function setCaptureSheetMode(mode: CaptureSheetMode): void {
  if (current.open) publish({ open: true, mode });
}

export function closeCaptureSheet(): void {
  if (current !== CLOSED_CAPTURE_SHEET) publish(CLOSED_CAPTURE_SHEET);
}

export function useCaptureSheet(): CaptureSheetState {
  return useSyncExternalStore(subscribe, snapshot, () => CLOSED_CAPTURE_SHEET);
}
