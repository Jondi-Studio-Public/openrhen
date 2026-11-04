import { createClientId } from "@/shared/client-id";
import type { PortalState } from "@/state/portal-state";
import { postRevert } from "@/features/pulse/reentry-client";

/** The server refused the answer (409): the offer is gone or already answered. The message is for the person. */
export class StretchRefusedError extends Error {
  constructor() {
    super("That stretch is no longer on offer.");
  }
}

/** Reads the current state, so a stale offer gives way to what stands now. Null when the read fails. */
export async function fetchState(): Promise<PortalState | null> {
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { state?: PortalState };
    return body.state ?? null;
  } catch {
    return null;
  }
}

export interface StretchAnswerBody {
  choice: "accept" | "decline" | "decline_all";
  /** The offered action; `decline_all` names none. */
  actionId?: string;
}

export interface StretchDone {
  state: PortalState | null;
  /** The command id the owner's undo takes. */
  revertible: string;
  outcome: "accepted" | "declined" | "declined_all";
}

/**
 * Answers a stretch offer from the owner's own tap (`POST /api/commands/stretch`). The command id is made here, so a
 * double tap that repeats the request is one answer. A refusal (409) carries the server's sentence.
 */
export async function postStretch(body: StretchAnswerBody): Promise<StretchDone> {
  const commandId = createClientId();
  const response = await fetch("/api/commands/stretch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId, ...body })
  });
  const result = (await response.json().catch(() => ({}))) as {
    state?: PortalState;
    revertible?: string;
    result?: { outcome?: StretchDone["outcome"] };
    error?: string;
  };
  // The server's refusal text speaks to an agent ("Next: call rhen_status ..."); the person gets one honest line.
  if (response.status === 409) throw new StretchRefusedError();
  if (!response.ok) throw new Error("That answer was not saved. Try again.");
  return {
    state: result.state ?? null,
    revertible: result.revertible ?? commandId,
    outcome:
      result.result?.outcome ??
      (body.choice === "accept" ? "accepted" : body.choice === "decline" ? "declined" : "declined_all")
  };
}

/** Puts the earlier answers back, through the undo every owner-written command uses. */
export const undoStretch = postRevert;
