"use client";

import { useCallback, useEffect, useState } from "react";
import { usePortal } from "@/state/portal-provider";
import type { StoredSleepPlan } from "@/state/portal-state";
import { SleepLogList } from "@/features/sleep-log/components/sleep-log-list";

/**
 * The one obvious place to see and correct recent nights. `usePortal()` is read here only for the
 * timezone nights are displayed in — its own `sleepPlans` list is a deliberately narrower window than
 * `/api/sleep-log` returns, so this page keeps its own copy and refetches it after every mutation
 * rather than folding the two together.
 */
export default function SleepLogPage() {
  const { state } = usePortal();
  const timezone = state.settings.timezone;
  const [plans, setPlans] = useState<StoredSleepPlan[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/sleep-log?days=30", { cache: "no-store" });
      const body = (await response.json().catch(() => ({}))) as { sleepPlans?: StoredSleepPlan[]; error?: string };
      if (!response.ok || !body.sleepPlans) throw new Error(body.error ?? "Recent nights could not be loaded.");
      setPlans(body.sleepPlans);
      setError("");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Recent nights could not be loaded.");
      setPlans([]);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void load();
  }, [load]);

  if (!plans)
    return (
      <main className="content-page">
        <p className="eyebrow">Sleep</p>
        <p>Loading recent nights…</p>
      </main>
    );

  return (
    <main className="content-page">
      <h1>Sleep</h1>
      <p className="reason">
        Every night from the last 30 days — tracked live from Now, or logged by hand. Fix a time that is wrong, or add
        one the app never saw.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <SleepLogList plans={plans} timezone={timezone} onChanged={load} />
    </main>
  );
}
