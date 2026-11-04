"use client";

import { useConnectionExtensionReads } from "./connection-extensions";
import { useCallback, useEffect, useState } from "react";
import type { GoogleCalendarProofResult, PlanningRuntimeState } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { useCalendarSync, type CalendarSyncLastRun } from "@/features/calendar-sync/use-calendar-sync";

export type EngineProbe =
  | { state: "loading" }
  | {
      state: "reachable";
      latencyMs: number;
      status: string;
      contractVersion: string | null;
      engineVersion: string | null;
    }
  | { state: "unreachable"; configured: boolean; detail: string };

/** A provider's telemetry name (`openai`, `google`, `google_calendar`, or one a connection adds). */
export type ProviderName = string;

export interface ProviderCallCount {
  operation: string;
  count: number;
}

export interface ProviderStatusView {
  provider: ProviderName;
  reachable: boolean | null;
  source: "real_call" | "probe" | "none" | "skipped" | "not_configured";
  checkedAt: string | null;
  detail: string | null;
  rateLimited: boolean;
  avgFirstByteMs: number | null;
  firstByteSampleCount: number;
  avgTotalMs: number | null;
  totalSampleCount: number;
  lastCallAt: string | null;
  lastCallOk: boolean | null;
  lastCallOperation: string | null;
  callCountsByOperation: ProviderCallCount[];
  inputTokens24h: number | null;
  outputTokens24h: number | null;
}

/** Everything the connection rows are worked out from; the page and the You overview share it. */
export interface ConnectionInputs {
  ready: boolean;
  timezone: string;
  planning: PlanningRuntimeState | undefined;
  probe: EngineProbe;
  providers: Partial<Record<ProviderName, ProviderStatusView>>;
  googleProof: GoogleCalendarProofResult | { status: "loading" };
  googleSync: CalendarSyncLastRun;
  /** Each registered connection extension's live read, by id (`connection-extensions.ts`). */
  extensions: Record<string, unknown>;
}

/**
 * The lightweight reads behind every connection row: engine health, provider statuses, the Google Calendar proof and its last sync (each connection extension reads its own). Each
 * read leaves what it last knew if it fails. The Connections page keeps the refreshers for its buttons;
 * the You overview only reads `inputs`.
 */
export function useConnectionData() {
  const { state, ready } = usePortal();

  const [probe, setProbe] = useState<EngineProbe>({ state: "loading" });
  const [probing, setProbing] = useState(false);
  const probeEngine = useCallback(async () => {
    setProbing(true);
    setProbe({ state: "loading" });
    try {
      const response = await fetch("/api/health/engine", { cache: "no-store" });
      const body = (await response.json()) as {
        reachable: boolean;
        configured: boolean;
        latencyMs?: number;
        status?: string;
        contractVersion?: string | null;
        engineVersion?: string | null;
        detail?: string;
      };
      setProbe(
        body.reachable
          ? {
              state: "reachable",
              latencyMs: body.latencyMs ?? 0,
              status: body.status ?? "unknown",
              contractVersion: body.contractVersion ?? null,
              engineVersion: body.engineVersion ?? null
            }
          : {
              state: "unreachable",
              configured: body.configured,
              detail: body.detail ?? "The engine could not be reached."
            }
      );
    } catch {
      setProbe({
        state: "unreachable",
        configured: true,
        detail: "The portal could not reach its own engine health endpoint."
      });
    } finally {
      setProbing(false);
    }
  }, []);

  const [providers, setProviders] = useState<Partial<Record<ProviderName, ProviderStatusView>>>({});
  const [checkingProvider, setCheckingProvider] = useState<ProviderName | null>(null);
  const loadProviderStatuses = useCallback(async () => {
    try {
      const response = await fetch("/api/connections/status", { method: "POST", cache: "no-store" });
      const body = (await response.json()) as { providers?: ProviderStatusView[] };
      const next: Partial<Record<ProviderName, ProviderStatusView>> = {};
      for (const status of body.providers ?? []) next[status.provider] = status;
      setProviders((previous) => ({ ...previous, ...next }));
    } catch {
      // Leave whatever was there before: a reload or "Check now" will try again.
    }
  }, []);
  const checkProviderNow = async (provider: ProviderName) => {
    setCheckingProvider(provider);
    try {
      const response = await fetch(`/api/connections/status?provider=${provider}`, {
        method: "POST",
        cache: "no-store"
      });
      const body = (await response.json()) as { providers?: ProviderStatusView[] };
      const status = body.providers?.[0];
      if (status) setProviders((previous) => ({ ...previous, [provider]: status }));
    } catch {
      // The badge simply keeps showing whatever it last knew.
    } finally {
      setCheckingProvider(null);
    }
  };

  const [googleProof, setGoogleProof] = useState<GoogleCalendarProofResult | { status: "loading" }>({
    status: "loading"
  });
  const googleSync = useCalendarSync("google_calendar");
  const reloadGoogleSync = googleSync.reload;
  const loadGoogleProof = useCallback(async () => {
    try {
      const response = await fetch("/api/connections/google_calendar/proof", { cache: "no-store" });
      const body = (await response.json()) as GoogleCalendarProofResult;
      if (!body || typeof body.status !== "string") throw new Error("unexpected proof response");
      setGoogleProof(body);
    } catch {
      setGoogleProof({
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: "The portal could not reach the Google Calendar proof endpoint."
      });
    }
  }, []);
  /** The Google Calendar details re-check themselves; this keeps the row in step with them. */
  const reloadGoogle = useCallback(async () => {
    await Promise.all([loadGoogleProof(), reloadGoogleSync()]);
  }, [loadGoogleProof, reloadGoogleSync]);

  const extensionReads = useConnectionExtensionReads();
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- each of these sets state only after its awaited request settles
    void probeEngine();
    void loadProviderStatuses();
    void loadGoogleProof();
  }, [probeEngine, loadProviderStatuses, loadGoogleProof]);

  const inputs: ConnectionInputs = {
    ready,
    timezone: state.settings.timezone,
    planning: state.planning,
    probe,
    providers,
    googleProof,
    googleSync: googleSync.lastRun,
    extensions: extensionReads
  };

  return {
    inputs,
    probing,
    probeEngine,
    checkingProvider,
    checkProviderNow,
    reloadGoogle
  };
}
