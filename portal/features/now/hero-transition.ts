import { flushSync } from "react-dom";
import type { PortalState } from "@/state/portal-state";

/** The attribute Now puts on its hero; the transition runs only while one is on screen. */
export const NOW_HERO_ATTRIBUTE = "data-now-hero";

/**
 * What decides which thing Now's hero is showing: the session holding the clock, the engine's
 * directive and its first pick, and where each routine step stands (a skipped or finished step moves
 * a routine on without the directive changing). Pausing, saving a field or a poll that changes
 * nothing leaves it alone, so those never animate.
 */
export function heroIdentity(state: PortalState): string {
  const result = state.planning?.result;
  const directive = result?.currentDirective;
  return [
    state.activeSession?.id ?? "",
    state.activeSession?.status === "feedback" ? "feedback" : "",
    directive ? `${directive.kind}:${"targetId" in directive ? directive.targetId : ""}` : "",
    (result?.recommendation as { primary?: { action?: { id?: string } } | null } | undefined)?.primary?.action?.id ??
      "",
    state.routineSteps.map((step) => `${step.id}:${step.status}`).join(",")
  ].join("|");
}

type DocumentWithTransitions = Document & { startViewTransition?: (update: () => void) => unknown };

/**
 * Applies a new state, through the `now-hero` view transition when it changes what Now's hero shows:
 * the old hero fades while the new one rises into its place, so Start, Skip, Done and a fresh plan
 * read as the same slot taking a new task. Anything else (another page, an unchanged hero, reduced
 * motion, a browser without view transitions, a hidden tab) applies the state directly.
 */
export function swapHero(previous: PortalState, next: PortalState, apply: () => void): void {
  const doc = typeof document === "undefined" ? undefined : (document as DocumentWithTransitions);
  if (
    !doc?.startViewTransition ||
    doc.hidden ||
    !doc.querySelector(`[${NOW_HERO_ATTRIBUTE}]`) ||
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ||
    heroIdentity(previous) === heroIdentity(next)
  ) {
    apply();
    return;
  }
  doc.startViewTransition(() => flushSync(apply));
}
