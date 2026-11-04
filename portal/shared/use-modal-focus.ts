"use client";

import { useEffect, useState, type KeyboardEvent, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Whether `el` is laid out: not `display:none` itself or inside one, nor inside a closed `<details>`. */
function isRendered(el: HTMLElement, root: HTMLElement): boolean {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    if (getComputedStyle(node).display === "none") return false;
    if (node instanceof HTMLDetailsElement && !node.open) {
      // Only the direct summary of a closed details stays visible.
      const summary = [...node.children].find((child) => child.tagName === "SUMMARY");
      if (!summary || !summary.contains(el)) return false;
    }
    if (node === root) break;
  }
  return true;
}

/**
 * Focus trap, Escape-to-close, and focus restore for an `aria-modal="true"` dialog — the behaviour
 * every modal in the portal needs and, before this hook existed, only Sheet actually had.
 *
 * While `active`, Tab is trapped within `trapRef`'s subtree, Escape calls `onClose`, body scroll is
 * locked (unless `lockScroll` is false), and focus lands on the first focusable element found under
 * `initialFocusRef` (or `trapRef` itself when nothing under it is focusable) — using the first
 * candidate actually rendered, since a single querySelector can happily return a `display:none`
 * element that merely comes first in document order (a plan editor's collapsed `<summary>` does
 * exactly that). When `active` turns false, focus returns to whatever had it before the dialog
 * opened.
 */
export function useModalFocus({
  active,
  trapRef,
  initialFocusRef,
  onClose,
  lockScroll = true,
  focusDialog = false
}: {
  active: boolean;
  trapRef: RefObject<HTMLElement | null>;
  /** Where to look for the element that takes initial focus. Defaults to `trapRef`. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  lockScroll?: boolean;
  /** Focus the dialog itself (named by its title) rather than its first control, for content that arrives later. */
  focusDialog?: boolean;
}): { onKeyDown: (event: KeyboardEvent) => void } {
  // The opener is read while rendering the opening, not in the effect: a field inside with `autoFocus`
  // takes focus during the commit, before any effect runs, and restoring to that field once it has
  // unmounted dropped focus on <body>.
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [wasActive, setWasActive] = useState(false);
  if (active !== wasActive) {
    setWasActive(active);
    if (active && typeof document !== "undefined")
      setOpener(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  }

  useEffect(() => {
    if (!active) return;
    const scope = initialFocusRef?.current ?? trapRef.current;
    // A field that asked for focus itself keeps it; otherwise the first rendered control takes it.
    if (focusDialog) trapRef.current?.focus();
    else if (!(document.activeElement instanceof HTMLElement && scope?.contains(document.activeElement))) {
      const candidates = [...(scope?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      const first = candidates.find((el) => getComputedStyle(el).display !== "none");
      (first ?? trapRef.current)?.focus();
    }
    const { overflow } = document.body.style;
    if (lockScroll) document.body.style.overflow = "hidden";
    return () => {
      if (lockScroll) document.body.style.overflow = overflow;
      opener?.focus();
    };
    // Only re-run when the dialog opens or closes: re-scanning candidates on every content change
    // (e.g. a form's own re-renders) would steal focus back from wherever the user has since moved it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !trapRef.current) return;
    const trap = trapRef.current;
    const focusable = [...trap.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => isRendered(el, trap));
    if (!focusable.length) {
      event.preventDefault();
      trapRef.current.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const activeElement = document.activeElement;
    if (event.shiftKey && (activeElement === first || activeElement === trapRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return { onKeyDown };
}
