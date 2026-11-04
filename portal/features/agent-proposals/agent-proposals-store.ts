"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { AgentProposal, AgentProposalConflict } from "@openrhen/contracts";
import { isWithinHandledWindow, type HandledRow } from "@/shared/recently-handled";

/**
 * The agents' proposals, held in one module-level store like the email and calendar review counts so the
 * shell's badge and the Captured room share one request. A failed read keeps the last known list.
 */
let current: readonly AgentProposal[] = [];
let lastFetchAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const empty: readonly AgentProposal[] = [];
/**
 * Proposals the person just tried to confirm that came back stale. The portal settles them, so a plain
 * pending list would drop the card with its "Ask it again" the moment it refreshed; these stay listed until
 * dismissed. Held in this store so the Inbox and Review keep the same card.
 */
const held = new Set<string>();

export const AGENT_PROPOSALS_MIN_INTERVAL_MS = 60_000;
export const AGENT_PROPOSALS_POLL_MS = 5 * 60_000;

function publish(next: readonly AgentProposal[]) {
  current = next;
  for (const listener of listeners) listener();
}

/** Reads `GET /api/agent-proposals`. Concurrent callers share one request. */
export function refreshAgentProposals(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch("/api/agent-proposals?limit=200", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { proposals?: unknown } | null;
      if (!Array.isArray(body?.proposals)) return;
      publish(body.proposals as AgentProposal[]);
    } catch {
      // Keep the last known list.
    } finally {
      lastFetchAt = Date.now();
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test hook: forget everything the store knows. */
export function resetAgentProposals() {
  current = empty;
  held.clear();
  lastFetchAt = 0;
  inFlight = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAgentProposals(): readonly AgentProposal[] {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => empty
  );
}

/** Mount once, in the shell: refresh on load, on focus (at most once a minute) and every five minutes. */
export function useAgentProposalsRefresh() {
  useEffect(() => {
    void refreshAgentProposals();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFetchAt < AGENT_PROPOSALS_MIN_INTERVAL_MS) return;
      void refreshAgentProposals();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    const timer = window.setInterval(() => void refreshAgentProposals(), AGENT_PROPOSALS_POLL_MS);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.clearInterval(timer);
    };
  }, []);
}

export function pendingAgentProposals(proposals: readonly AgentProposal[]): AgentProposal[] {
  return proposals.filter((proposal) => proposal.status === "pending");
}

/** What the lists show: the pending proposals, and any the person found stale and has not dismissed yet. Counts stay pending-only. */
export function shownAgentProposals(proposals: readonly AgentProposal[]): AgentProposal[] {
  return proposals.filter(
    (proposal) => proposal.status === "pending" || (proposal.status === "stale" && held.has(proposal.id))
  );
}

/** Clears a stale card the person has read. */
export function dismissHeldAgentProposal(id: string) {
  if (held.delete(id)) publish([...current]);
}

/** Decided proposals from the last seven days, as "Recently handled" rows. */
export function handledAgentRows(proposals: readonly AgentProposal[], now: number): HandledRow[] {
  return proposals
    .filter((proposal) => proposal.status !== "pending" && isWithinHandledWindow(proposal.resolvedAt, now))
    .map((proposal) => ({
      id: proposal.id,
      title: proposal.summary,
      detail: `from ${proposal.agent}${proposal.resolutionNote ? ` · ${proposal.resolutionNote}` : ""}`,
      outcome: proposal.status,
      at: proposal.resolvedAt ?? proposal.updatedAt
    }));
}

export type ResolveOutcome =
  { ok: true } | { ok: false; stale: boolean; changed?: boolean; message: string; conflicts: AgentProposalConflict[] };

export const CHANGED_MESSAGE = "The agent changed this after you opened it. Read it again before confirming.";

/** Confirms or rejects one proposal as the person, then refreshes the list. A 409 stale answer carries the diff. */
export async function resolveAgentProposalRequest(
  id: string,
  decision: "confirm" | "reject",
  revision: number
): Promise<ResolveOutcome> {
  try {
    const response = await fetch(`/api/agent-proposals/${id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision, revision })
    });
    if (response.ok) {
      await refreshAgentProposals();
      return { ok: true };
    }
    const body = (await response.json().catch(() => null)) as {
      error?: string;
      stale?: boolean;
      changed?: boolean;
      conflicts?: AgentProposalConflict[];
    } | null;
    // A stale or already-decided proposal changed state on the server; show it as it now stands. A stale one
    // stays listed with its message until dismissed.
    if (response.status === 409) {
      if (body?.changed === true) {
        // The agent replaced the proposal after the card rendered: show the new one, never hold it.
        await refreshAgentProposals();
        return { ok: false, stale: false, changed: true, message: CHANGED_MESSAGE, conflicts: [] };
      }
      if (body?.stale === true) held.add(id);
      await refreshAgentProposals();
    }
    return {
      ok: false,
      stale: body?.stale === true,
      message: body?.error ?? "That could not be done.",
      conflicts: body?.conflicts ?? []
    };
  } catch {
    return { ok: false, stale: false, message: "The portal could not be reached.", conflicts: [] };
  }
}

/** "5 min ago", "3 h ago", "2 d ago". */
export function ageLabel(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
