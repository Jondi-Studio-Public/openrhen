"use client";

/**
 * `/inbox#capture` is read when this module loads, before hydration and any router redirect can drop
 * the hash, and consumed once by the Inbox's Add button. A hash seen later (a link followed within the
 * app) is read by the button directly.
 */
let hashAtLoad = typeof window !== "undefined" && window.location.hash === "#capture";

export function consumeCaptureHash(): boolean {
  const seen = hashAtLoad || (typeof window !== "undefined" && window.location.hash === "#capture");
  hashAtLoad = false;
  return seen;
}
