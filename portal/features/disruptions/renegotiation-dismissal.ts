/**
 * Whether "Not now" on the renegotiation panel (`components/renegotiation-panel.tsx`) has already
 * been said for the exact verdict currently on screen. Before this, dismissal lived in `useState`
 * alone: any remount — a navigation, a reload, the periodic refresh Now already does — threw it away
 * and the same "This changes today" prompt came straight back, unsuppressable, for as long as the
 * disruption's `newlyDisplaced` set stayed the same. It lives in `localStorage`
 * because this is a per-browser "I've seen this" mark, not planning truth, so it has no business in
 * the server-synced state.
 *
 * Keyed by disruption id plus a stable serialization of the displaced set, not by disruption id alone
 * — an unchanged verdict stays dismissed; a changed one (a target added or dropped) is a new fact the
 * reader has not actually seen yet, and re-arms the prompt.
 */
const STORAGE_KEY = "openrhen.disruption-dismissal";

/** `targetId`s reduced to the one string two dismissal checks can compare — order-independent. */
export function displacedSignature(targetIds: readonly string[]): string {
  return [...targetIds].sort().join(",");
}

interface StoredDismissal {
  disruptionId: string;
  signature: string;
}

function readStored(): StoredDismissal | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as StoredDismissal).disruptionId === "string" &&
      typeof (parsed as StoredDismissal).signature === "string"
    )
      return parsed as StoredDismissal;
    return null;
  } catch {
    return null;
  }
}

/** Whether `disruptionId`'s displaced set, serialized to `signature`, was already dismissed. */
export function isDismissed(disruptionId: string, signature: string): boolean {
  const stored = readStored();
  return stored?.disruptionId === disruptionId && stored.signature === signature;
}

/** Remembers that `disruptionId`'s current displaced set (`signature`) has been dismissed. */
export function writeDismissal(disruptionId: string, signature: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ disruptionId, signature }));
  } catch {
    // A browser that refuses storage still hides the panel for this render, just not the next one.
  }
}
