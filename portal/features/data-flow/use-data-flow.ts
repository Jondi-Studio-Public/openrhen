"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DataFlowResponse } from "@openrhen/contracts/data-flow";
import { fetchDataFlow } from "./data-flow-client";

export const POLL_MS = 60_000;
/** A read that has not settled by then is abandoned, so a hung request cannot stop every later poll. */
export const READ_TIMEOUT_MS = 15_000;

export type DataFlowStatus = "loading" | "ready" | "error";

/**
 * The data-flow graph as state. It is read on mount and then every minute, but only while the page is visible: a hidden
 * page stops polling, and on coming back it reads at once if the last read is older than the interval. A failed read
 * keeps the last graph and sets `healthDown`, so the page can say "Health unavailable" over the static picture; the next
 * read that works clears it. With no graph yet, a failed read is an `error`.
 */
export function useDataFlow({ intervalMs = POLL_MS, poll = true }: { intervalMs?: number; poll?: boolean } = {}) {
  const [data, setData] = useState<DataFlowResponse | null>(null);
  const [status, setStatus] = useState<DataFlowStatus>("loading");
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const lastRead = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reading = useRef(false);
  const inFlight = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    const controller = new AbortController();
    inFlight.current = controller;
    const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    // Raced against the abort, so a read that ignores the signal still ends.
    const gaveUp = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("The data map took too long to read.")));
    });
    gaveUp.catch(() => {});
    try {
      const next = await Promise.race([fetchDataFlow(controller.signal), gaveUp]);
      if (!alive.current) return;
      lastRead.current = Date.now();
      setData(next);
      setStatus("ready");
      setFailed(false);
      setError("");
    } catch (readError) {
      if (!alive.current) return;
      lastRead.current = Date.now();
      setFailed(true);
      setError(readError instanceof Error ? readError.message : "The data map could not be read.");
      setStatus((current) => (current === "ready" ? "ready" : "error"));
    } finally {
      clearTimeout(timer);
      if (inFlight.current === controller) inFlight.current = null;
      reading.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const clear = () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
    const schedule = () => {
      clear();
      if (!poll || !visible()) return;
      timer.current = setTimeout(async () => {
        await load();
        if (alive.current) schedule();
      }, intervalMs);
    };
    const onVisibility = async () => {
      if (!visible()) {
        clear();
        return;
      }
      if (poll && Date.now() - lastRead.current >= intervalMs) await load();
      if (alive.current) schedule();
    };
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void load().then(() => {
      if (alive.current) schedule();
    });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive.current = false;
      inFlight.current?.abort();
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, load, poll]);

  const healthDown = failed || data?.health.unavailable === true;
  return { data, status, error, healthDown, reload: load };
}
