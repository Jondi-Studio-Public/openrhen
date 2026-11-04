"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CATCH_UP_DUE_AFTER_HOURS, type CatchUpLedger } from "@openrhen/contracts";
import { useConnectionLapses } from "@/features/connections/connection-lapses";
import { useNow } from "@/shared/clock";
import { usePortal } from "@/state/portal-provider";
import { pulseNeedsReentry } from "@/features/pulse/pulse-view";
import { fetchCatchUp } from "@/features/catch-up/catch-up-client";
import { showBanner } from "@/features/catch-up/catch-up-model";
import { inboxBadge } from "@/features/inbox/rooms";
import { useRoomCounts } from "@/features/inbox/use-room-counts";
import { useAgentChangesLookedAt } from "@/features/review/agent-changes-seen";
import {
  agentChangesSince,
  agentChangesUnseen,
  awaySince,
  showWelcomeBack,
  welcomeBackRows,
  type WelcomeBackRow
} from "./welcome-back";

/** Per device: what one phone or desk last marked seen is not what the other did. */
export const LAST_SEEN_KEY = "openrhen.welcomeBack.lastSeenAt";

/** The most `/api/agent-changes` returns in a page; more than this since last visit reads as this many. */
const AGENT_CHANGES_PAGE = 100;

export interface WelcomeBack {
  show: boolean;
  /** The later of when this device was last marked seen and when anything was last recorded, else null. */
  awaySince: string | null;
  rows: WelcomeBackRow[];
  /** Records now as the last time seen, so every "since" count restarts from here. */
  markSeen: () => void;
  /** Applied agent writes since this device last showed Plan > Review > Agent changes (all of them if it never has). */
  agentChangesSinceLooked: number;
  /** True when this device has never shown the list, so there is no "since". */
  agentChangesNeverLooked: boolean;
}

function readLastSeen(): string | null {
  try {
    return window.localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

/** What this tab last wrote, so a blocked storage write still moves the "since" for this visit. */
let written: string | null = null;
const listeners = new Set<() => void>();

function writeLastSeen(value: string) {
  written = value;
  try {
    window.localStorage.setItem(LAST_SEEN_KEY, value);
  } catch {
    // Storage blocked or full: the banner just comes back next visit.
  }
  for (const listener of listeners) listener();
}

function subscribeLastSeen(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Null on the server and during hydration, so the banner never flips on in the first render. */
function useLastSeen(): string | null {
  return useSyncExternalStore(
    subscribeLastSeen,
    () => written ?? readLastSeen(),
    () => null
  );
}

type AgentChangeStamp = { at: string; status: "applied" | "undone" | "superseded" };

/** Agent writes with their times and statuses, or an empty list when they cannot be read. */
async function readAgentChanges(): Promise<AgentChangeStamp[]> {
  try {
    const response = await fetch(`/api/agent-changes?limit=${AGENT_CHANGES_PAGE}`, { cache: "no-store" });
    const body = response.ok ? ((await response.json()) as { changes?: unknown } | null) : null;
    return Array.isArray(body?.changes) ? (body.changes as AgentChangeStamp[]) : [];
  } catch {
    return [];
  }
}

/**
 * The data behind the "Welcome back" banner and sheet: the catch-up ledger the old banner reads, agent
 * changes since `lastSeenAt` (the list Plan > Review shows), and the number on the Inbox badge. A read
 * that fails leaves its row out rather than showing a count that cannot be checked.
 */
export function useWelcomeBack(): WelcomeBack {
  const now = useNow("minute");
  const inbox = inboxBadge(useRoomCounts());
  const lastSeenAt = useLastSeen();
  const lapsed = useConnectionLapses().lapsed;
  const lookedAt = useAgentChangesLookedAt();
  const { state } = usePortal();
  // While the pulse is lapsed the re-entry sheet on Now is the catch-up, so the banner leaves it out; a re-entry
  // (or its undo) moves `since`, which reads the ledger again so the settled things drop off.
  const lapsedPulse = pulseNeedsReentry(state.pulse);
  const pulseSince = state.pulse?.since ?? null;
  const [ledger, setLedger] = useState<CatchUpLedger | null>(null);
  const [changes, setChanges] = useState<AgentChangeStamp[]>([]);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      void fetchCatchUp()
        .then((next) => {
          if (!cancelled) setLedger(next);
        })
        .catch(() => {});
      void readAgentChanges().then((next) => {
        if (!cancelled) setChanges(next);
      });
    };
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pulseSince]);

  const catchUpDue = showBanner(ledger) && !lapsedPulse;
  const rows = useMemo(
    () =>
      welcomeBackRows({
        catchUp: lapsedPulse ? 0 : (ledger?.unsettled ?? 0),
        // Reads NowAnswer `needs` once the trust thread's freshness PR ships; the row is absent until then.
        needs: 0,
        agentChanges: agentChangesSince(changes, lastSeenAt),
        inbox,
        lapsedConnections: lapsed.map((connection) => connection.label)
      }),
    [ledger?.unsettled, lapsedPulse, changes, lastSeenAt, inbox, lapsed]
  );
  const show = showWelcomeBack({
    catchUpDue,
    catchUpSince: ledger?.since ?? null,
    rows,
    lastSeenAt,
    now,
    // The window the server uses to call a catch-up due; there is no per-person setting for it.
    afterHours: CATCH_UP_DUE_AFTER_HOURS
  });

  const markSeen = useCallback(() => {
    const stamp = new Date().toISOString();
    writeLastSeen(stamp);
  }, []);

  const agentChangesSinceLooked = useMemo(() => agentChangesUnseen(changes, lookedAt), [changes, lookedAt]);

  return {
    show,
    awaySince: awaySince(lastSeenAt, ledger?.since ?? null),
    rows,
    markSeen,
    agentChangesSinceLooked,
    agentChangesNeverLooked: lookedAt === null
  };
}
