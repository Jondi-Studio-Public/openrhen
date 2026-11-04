"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a CSS media query matches, kept live. Reports `false` on the server and during hydration,
 * so a page that picks a phone or desk composition from it starts with the phone one and switches
 * on the client rather than mismatching the markup it was served.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaQueryList(query);
      if (!list) return () => {};
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => mediaQueryList(query)?.matches ?? false,
    () => false
  );
}

/**
 * The live list for a query, or null where there is none to ask: the server, and the bare DOM a
 * component test runs in, which implements no media queries. Both answer "not matching", which is the
 * phone composition — the one every page is written to work in.
 */
function mediaQueryList(query: string): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(query);
}
