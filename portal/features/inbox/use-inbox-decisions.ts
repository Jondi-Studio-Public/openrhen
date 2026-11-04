"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

/** Which way a handled card leaves: toward the plan for a confirm, away from it for an ignore. */
export type Exit = "confirm" | "ignore";

/** What the toast offers after a decision: a true undo, or the way to the room's record of it. */
export type ToastAction = { kind: "undo"; run: () => Promise<void> } | { kind: "view" };

export interface DecisionToast {
  /** Bumps on every decision, so a merged toast restarts its clock. */
  key: number;
  exit: Exit;
  ids: string[];
  /** How many were tried, when more than `ids` landed (a bulk ignore where some writes failed): "Ignored 7 of 9". */
  attempted?: number;
  action: ToastAction;
  /** What the toast calls the decision when the button said something other than Confirm or Ignore ("Dropped"). */
  verb?: string;
  /** What the decision was made on ("link"), where the verb alone would not say, so the toast reads "Link confirmed". */
  noun?: string;
  /** A sentence naming what a single decision did ("Added to Family: Buy ink"); the toast shows it in place of the verb. */
  subject?: string;
}

/** How long the card's exit runs before the list closes the gap (the CSS uses the same 160ms). */
export const EXIT_MS = 160;
/** How long the toast stays unless the pointer or focus is on it. */
export const TOAST_MS = 6000;

/** The class `styles.css` keys the list's reflow on, so only an Inbox decision names its cards. */
const REFLOW_CLASS = "inbox-reflow";

const reducedMotion = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `update` inside a View Transition, so the cards below a removed one slide up rather than jump,
 * where the browser has them and motion is welcome; otherwise it simply runs.
 */
function withReflow(update: () => void) {
  const doc = typeof document === "undefined" ? null : document;
  if (!doc || typeof doc.startViewTransition !== "function" || reducedMotion()) return update();
  doc.documentElement.classList.add(REFLOW_CLASS);
  const transition = doc.startViewTransition(() => flushSync(update));
  void transition.finished.finally(() => doc.documentElement.classList.remove(REFLOW_CLASS));
}

/**
 * The Inbox's decision moves, shared by every room: a handled card first leaves (`leaving`, 160ms),
 * then is hidden at once (`hidden`) while its write runs, so the list closes up without waiting on the
 * server, and a toast says what happened. A refused write brings the card back, so its own error can
 * show; the write's rejection is passed on to the caller. Decisions of one kind made while the toast is
 * up join it ("Ignored 3"), and its Undo covers all of them.
 */
export function useInboxDecisions() {
  const [leaving, setLeaving] = useState<ReadonlyMap<string, Exit>>(new Map());
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [toast, setToast] = useState<DecisionToast | null>(null);
  // `decide` reads the toast as it is when a write settles, not as it was when the click began.
  const toastRef = useRef<DecisionToast | null>(null);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);
  const counter = useRef(0);

  const release = useCallback((ids: readonly string[]) => {
    setLeaving((current) => {
      const next = new Map(current);
      for (const id of ids) next.delete(id);
      return next;
    });
    setHidden((current) => {
      const next = new Set(current);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const decide = useCallback(
    async (
      ids: readonly string[],
      exit: Exit,
      write: () => Promise<boolean | void | readonly string[]>,
      action: ToastAction = { kind: "view" },
      verb?: string,
      noun?: string,
      subject?: string
    ): Promise<boolean> => {
      if (!ids.length) return false;
      setLeaving((current) => new Map([...current, ...ids.map((id) => [id, exit] as const)]));
      if (!reducedMotion()) await wait(EXIT_MS);
      withReflow(() =>
        setHidden((current) => {
          const next = new Set(current);
          for (const id of ids) next.add(id);
          return next;
        })
      );
      let saved: boolean;
      // A write that names the ids that landed (a bulk ignore) is honest about a partial failure: the
      // toast counts, and its Undo covers, only those.
      let landed: readonly string[] = ids;
      try {
        const result = await write();
        if (Array.isArray(result)) landed = result as readonly string[];
        saved = result !== false && landed.length > 0;
      } catch (error) {
        release(ids);
        throw error;
      }
      // Saved, the portal state no longer lists these as waiting, so the local hiding can go; refused,
      // the card comes back.
      release(ids);
      if (!saved) return false;
      const open = toastRef.current;
      const merge =
        open &&
        !subject &&
        !open.subject &&
        open.exit === exit &&
        open.action.kind === action.kind &&
        open.verb === verb &&
        open.noun === noun;
      const allIds = merge ? [...open.ids, ...landed] : [...landed];
      const attempted = (merge ? (open.attempted ?? open.ids.length) : 0) + ids.length;
      const merged: ToastAction =
        merge && open.action.kind === "undo" && action.kind === "undo"
          ? {
              kind: "undo",
              run: ((earlier, later) => async () => {
                await earlier();
                await later();
              })(open.action.run, action.run)
            }
          : action;
      counter.current += 1;
      setToast({
        key: counter.current,
        exit,
        ids: allIds,
        ...(attempted > allIds.length ? { attempted } : {}),
        action: merged,
        ...(verb ? { verb } : {}),
        ...(noun ? { noun } : {}),
        ...(subject ? { subject } : {})
      });
      return true;
    },
    [release]
  );

  const dismiss = useCallback(() => setToast(null), []);

  return { leaving, hidden, toast, decide, dismiss };
}

export type InboxDecisions = ReturnType<typeof useInboxDecisions>;

/**
 * The toast's clock: six seconds from the latest decision, held while the pointer or focus is on it so
 * nobody loses an Undo they are reaching for.
 */
export function useToastClock(toast: DecisionToast | null, dismiss: () => void) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!toast || held) return;
    const timer = window.setTimeout(dismiss, TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, held, dismiss]);
  return { hold: () => setHeld(true), letGo: () => setHeld(false) };
}
