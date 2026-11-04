"use client";

import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMediaQuery } from "@/shared/use-media-query";
import { useModalFocus } from "@/shared/use-modal-focus";
import motion from "./sheet.module.css";

/** How far past the header a swipe has to travel, in CSS pixels, before it counts as a dismiss. */
const SWIPE_DISMISS_PX = 120;
/** Upper bound on how long a closing sheet stays mounted waiting for its exit transition. The
 * transition itself runs for 200ms (sheet.module.css); this is only a safety net for a transitionend
 * that never fires (e.g. the panel was already unmounted from the DOM some other way). */
const EXIT_FALLBACK_MS = 320;

type Phase = "entering" | "open" | "closing" | null;

/**
 * A modal that rises from the bottom of a phone screen and sits centred on a desk. It holds one
 * task — a form, a picker — that would otherwise take a page or a permanent block of the page it
 * belongs to. Focus stays inside while it is open, Escape and the backdrop close it, and focus goes
 * back to whatever opened it. Nothing is rendered while fully closed, so its content costs nothing
 * and no duplicate form controls linger in the document.
 *
 * Opening and closing both animate — translateY + opacity on the drawer curve, 300ms in and 200ms out — except under
 * prefers-reduced-motion, where the sheet simply appears and disappears. Closing keeps the sheet
 * mounted until the exit transition ends (or a timeout, as a backstop) rather than yanking it out
 * mid-animation. On a touch device the header can also be dragged down to dismiss, springing back if
 * the drag doesn't clear the threshold.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  className = "",
  focusDialog = false
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  className?: string;
  /** Focus lands on the dialog itself, read out by its title, instead of its first control. */
  focusDialog?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [phase, setPhase] = useState<Phase>(open ? (reducedMotion ? "open" : "entering") : null);
  const [dragY, setDragY] = useState(0);
  const gesture = useRef<{ startY: number } | null>(null);
  const [wasOpen, setWasOpen] = useState(open);

  // `open` flipping is reflected in `phase` synchronously, in the same render, rather than through an
  // effect a commit later: `useModalFocus` below (and the entrance-transition effect further down)
  // both act on `panel.current`, which only exists once this component's own JSX has actually
  // rendered the dialog — so phase has to already be right by the time that JSX is produced, not one
  // render behind it.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPhase(reducedMotion ? "open" : "entering");
    } else {
      setDragY(0);
      setPhase((current) => (current === null ? null : reducedMotion ? null : "closing"));
    }
  }

  const { onKeyDown } = useModalFocus({
    active: open,
    trapRef: panel,
    initialFocusRef: body,
    onClose,
    focusDialog
  });

  // Entering: mounted off-screen/transparent already; flip to the resting state a frame later so the
  // browser actually has something to transition from.
  useEffect(() => {
    if (phase !== "entering") return;
    const raf = requestAnimationFrame(() => setPhase("open"));
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // Closing: stay mounted in the offset state until the exit transition ends (or the fallback timer
  // fires, in case transitionend never does) before actually unmounting.
  useEffect(() => {
    if (phase !== "closing") return;
    const panelEl = panel.current;
    const finish = () => setPhase(null);
    const timeout = setTimeout(finish, EXIT_FALLBACK_MS);
    panelEl?.addEventListener("transitionend", finish);
    return () => {
      clearTimeout(timeout);
      panelEl?.removeEventListener("transitionend", finish);
    };
  }, [phase]);

  if (phase === null || typeof document === "undefined") return null;

  const endDrag = (dismiss: boolean) => {
    gesture.current = null;
    setDragY(0);
    if (dismiss) onClose();
  };

  const onHeaderPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    // A mouse has no swipe-to-dismiss gesture; reading a mouse drag as one would just be confusing.
    // A sheet that's already closing doesn't need a second dismissal gesture on top of the one under way.
    if (event.pointerType === "mouse" || phase === "closing") return;
    gesture.current = { startY: event.clientY };
  };
  const onHeaderPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!gesture.current) return;
    const delta = event.clientY - gesture.current.startY;
    setDragY(Math.max(0, delta));
  };
  const onHeaderPointerUp = () => {
    if (!gesture.current) return;
    endDrag(dragY > SWIPE_DISMISS_PX);
  };
  const onHeaderPointerCancel = () => {
    if (gesture.current) endDrag(false);
  };

  return createPortal(
    <div
      className={`sheet-backdrop ${motion.backdrop}${phase === "closing" ? ` ${motion.closing}` : ""}`}
      data-phase={phase}
      role="presentation"
      // While closing, the sheet is still mounted for the exit transition but should act as if it
      // were already gone: `inert` pulls it out of the accessibility tree and focus order, and the
      // `.closing` class (pointer-events: none) stops it — and the backdrop's own click-to-dismiss —
      // from still responding to taps for that ~200ms.
      inert={phase === "closing" ? true : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        className={`sheet ${className} ${motion.panel}`.trim()}
        data-phase={phase}
        style={dragY > 0 ? { transform: `translateY(${dragY}px)`, transitionDuration: "0ms" } : undefined}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header
          className="sheet-header"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerCancel}
        >
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="icon-button" aria-label={`Close ${title}`} onClick={onClose}>
            ×
          </button>
        </header>
        <div ref={body} className="sheet-body">
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
