"use client";

import { useEffect, useState } from "react";
import type { CoordinationState, HandoffKind } from "@openrhen/contracts";
import { LiveUpdatesController, type EventSourceFactory } from "@/state/live-updates";

/**
 * One image attached to a stored turn. Mirrors `chat-panel.tsx`'s `ChatImage`, duplicated here rather
 * than imported so this hook has no dependency on the component that happens to consume it — the
 * handed-off overview consumes the same messages and never touches images.
 */
export interface CoordinationImage {
  filename: string;
  mimeType: string;
  dataUrl: string;
}

/**
 * One row of the deliverable's transcript as `GET /api/deliverables/[id]/chat` returns it. `external`
 * rows — posted by a desktop AI coordinator through `rhen deliverable …` — carry `meta`;
 * `user`/`assistant` rows never do. See the external coordination design note, "API contract (the
 * seam)" and `platform/contracts/src/portal/deliverable-coordination.ts` (`TranscriptRow`).
 */
export interface CoordinationMessage {
  id: string;
  role: "user" | "assistant" | "external";
  content: string;
  attachments: CoordinationImage[];
  createdAt: string;
  meta?: { kind: HandoffKind; tool: string };
}

/** The two prompt templates the workspace and `rhen deliverable handoff` both copy verbatim. */
export interface CoordinationPrompts {
  handoff: string;
  bringBack: string;
}

export interface UseCoordinationResult {
  /** Null while the first load is in flight; an empty array once a failed load has settled (see `error`). */
  messages: CoordinationMessage[] | null;
  /** Null until the first load resolves. */
  coordination: CoordinationState | null;
  /** Null until the first load resolves. */
  prompts: CoordinationPrompts | null;
  error: string;
  /** Re-fetches immediately, on top of the automatic reload triggers below. */
  reload: () => void;
}

/**
 * Loads `GET /api/deliverables/[id]/chat` — the thread, who (if anyone) is coordinating the
 * deliverable externally, and the two prompt templates — and keeps it fresh: on `deliverableId`
 * change, whenever the caller's `reloadKey` is bumped (the workspace already does this when something
 * outside the thread writes to it, e.g. attaching a source), and on every live `changed` event from
 * `/api/events`. A handoff row sits outside the normal aggregate-save pipeline, so nothing else would
 * tell an open tab that a pick-up or drop-off just landed — see the external coordination design note,
 * "Live updates".
 *
 * Used by both `ChatPanel` and `HandedOffOverview`; the workspace mounts exactly one of the two at a
 * time (see `deliverables/page.tsx`), so exactly one instance of this hook — and its one live
 * connection — is ever active for a given deliverable.
 *
 * `createEventSource` is for tests only; production callers omit it and get the real `EventSource`.
 */
export function useCoordination(
  deliverableId: string,
  reloadKey = 0,
  createEventSource?: EventSourceFactory
): UseCoordinationResult {
  const [messages, setMessages] = useState<CoordinationMessage[] | null>(null);
  const [coordination, setCoordination] = useState<CoordinationState | null>(null);
  const [prompts, setPrompts] = useState<CoordinationPrompts | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/deliverables/${encodeURIComponent(deliverableId)}/chat`);
        const payload = (await response.json()) as {
          messages?: CoordinationMessage[];
          coordination?: CoordinationState;
          prompts?: CoordinationPrompts;
          error?: string;
        };
        if (!response.ok || !payload.messages) throw new Error(payload.error ?? "The conversation could not load.");
        if (cancelled) return;
        setMessages(payload.messages);
        setCoordination(payload.coordination ?? null);
        setPrompts(payload.prompts ?? null);
        setError("");
      } catch (cause) {
        if (cancelled) return;
        setMessages([]);
        setError(cause instanceof Error ? cause.message : "The conversation could not load.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `tick` is the manual-reload trigger, not data.
  }, [deliverableId, reloadKey, tick]);

  useEffect(() => {
    if (!createEventSource && (typeof window === "undefined" || typeof window.EventSource === "undefined")) return;
    const controller = new LiveUpdatesController({
      createEventSource: createEventSource ?? ((url) => new EventSource(url)),
      callbacks: { onRefresh: () => setTick((current) => current + 1) }
    });
    controller.open();
    return () => controller.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reconnecting on every render would defeat the point.
  }, [deliverableId, createEventSource]);

  return { messages, coordination, prompts, error, reload: () => setTick((current) => current + 1) };
}
