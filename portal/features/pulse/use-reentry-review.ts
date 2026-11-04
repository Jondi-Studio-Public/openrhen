"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchReentry, type ReentryRead } from "./reentry-client";

export type ReentryLoad =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "healed" }
  | ({ status: "ready" } & ReentryRead);

/** Reads the review while the sheet is up; `reload` asks again (after a refusal, or a retry). */
export function useReentryReview(active: boolean): { load: ReentryLoad; reload: () => void } {
  const [load, setLoad] = useState<ReentryLoad>({ status: "loading" });
  const [reads, setReads] = useState(0);
  const reload = useCallback(() => setReads((count) => count + 1), []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetchReentry()
      .then((read) => {
        if (!cancelled) setLoad(read ? { status: "ready", ...read } : { status: "healed" });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoad({
            status: "error",
            message: error instanceof Error ? error.message : "The catch-up could not be read."
          });
      });
    return () => {
      cancelled = true;
    };
  }, [active, reads]);
  return { load, reload };
}
