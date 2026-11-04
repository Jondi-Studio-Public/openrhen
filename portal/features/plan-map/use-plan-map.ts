"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PlanLinkInput, PlanLinkKind, PlanMap, SwitchableAddon, PlanMapMode } from "@openrhen/contracts";
import {
  bulkConfirmPlanLinks,
  createPlanLink,
  decidePlanFinding,
  decidePlanLink,
  fetchPlanMap,
  setPlanMapSwitch
} from "@/features/plan-map/plan-map-client";

export type PlanMapLoad = "loading" | "ready" | "error";

/**
 * The plan map as state: loaded once on mount, reloaded after every change so what shows is what the
 * server holds. A failed read keeps whatever was last loaded and says so; a failed change leaves the
 * map as it was and reports beside the control that raised it. One change runs at a time. Undoing a
 * decision (`reopenLinks`, `reopenFinding`) is not one of them: it throws, for the toast that offered it
 * to show, and reloads either way.
 */
export function usePlanMap() {
  const [map, setMap] = useState<PlanMap | null>(null);
  const [status, setStatus] = useState<PlanMapLoad>("loading");
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [switchError, setSwitchError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await fetchPlanMap();
      if (!alive.current) return;
      setMap(next);
      setStatus("ready");
      setError("");
    } catch (loadError) {
      if (!alive.current) return;
      setStatus("error");
      setError(loadError instanceof Error ? loadError.message : "The plan map could not be loaded.");
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void load();
  }, [load]);

  const run = useCallback(
    async (change: () => Promise<void>, scope: "links" | "switch" = "links") => {
      const setFailure = scope === "switch" ? setSwitchError : setActionError;
      setBusy(true);
      setActionError("");
      setSwitchError("");
      try {
        await change();
        await load();
        return true;
      } catch (changeError) {
        if (alive.current) setFailure(changeError instanceof Error ? changeError.message : "That did not save.");
        return false;
      } finally {
        if (alive.current) setBusy(false);
      }
    },
    [load]
  );

  return {
    map,
    status,
    error,
    actionError,
    switchError,
    busy,
    reload: load,
    addLink: (input: PlanLinkInput) => run(() => createPlanLink(input).then(() => undefined)),
    decideLink: (id: string, action: "confirm" | "reject" | "remove") => run(() => decidePlanLink(id, action)),
    /** Resolves to the ids confirmed, or null when the change did not save. */
    bulkConfirm: async (proposer: string, kind: PlanLinkKind) => {
      let ids: string[] = [];
      const saved = await run(async () => {
        ids = await bulkConfirmPlanLinks(proposer, kind);
      });
      return saved ? ids : null;
    },
    decideFinding: (id: string, action: "accept" | "dismiss", answers?: Record<string, string>) =>
      run(() => decidePlanFinding(id, action, answers)),
    reopenLinks: async (ids: readonly string[]) => {
      try {
        for (const id of ids) await decidePlanLink(id, "reopen");
      } finally {
        await load();
      }
    },
    reopenFinding: async (id: string) => {
      try {
        await decidePlanFinding(id, "reopen");
      } finally {
        await load();
      }
    },
    setSwitch: (addon: SwitchableAddon, mode: PlanMapMode) => run(() => setPlanMapSwitch(addon, mode), "switch")
  };
}
export type PlanMapController = ReturnType<typeof usePlanMap>;
