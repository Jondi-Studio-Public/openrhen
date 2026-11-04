import { createClientId } from "@/shared/client-id";
import type { PortalState } from "@/state/portal-state";
import { refusalFrom, type ReentryChoices, type ReentryReview } from "./reentry-model";

export interface ReentryRead {
  review: ReentryReview;
  choices: ReentryChoices;
}

/** Reads the review for a lapsed pulse. Null: the pulse is not lapsed (it healed elsewhere). */
export async function fetchReentry(): Promise<ReentryRead | null> {
  const response = await fetch("/api/pulse/reentry", { cache: "no-store" });
  if (!response.ok) throw new Error("The catch-up could not be read.");
  const body = (await response.json()) as { lapsed?: boolean; review?: ReentryReview; choices?: ReentryChoices };
  if (!body.lapsed || !body.review) return null;
  return {
    review: { ...body.review, entries: body.review.entries ?? [] },
    choices: body.choices ?? { places: [], contexts: [] }
  };
}

/** A refused re-entry: the server's sentence, and each thing it still needs by name. */
export class ReentryRefusedError extends Error {
  constructor(
    message: string,
    readonly missing: string[]
  ) {
    super(message);
  }
}

export interface ReentryDone {
  state: PortalState | null;
  /** The command id `postRevert` takes. */
  revertible: string;
  unrecorded: number;
  lapsed: number;
}

export async function postReenter(body: Record<string, unknown>): Promise<ReentryDone> {
  const response = await fetch("/api/commands/reenter", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = (await response.json().catch(() => ({}))) as {
    state?: PortalState;
    revertible?: string;
    result?: { unrecorded?: number; lapsed?: number };
    error?: string;
  };
  if (!response.ok) {
    const refusal = refusalFrom(result);
    if (refusal) throw new ReentryRefusedError(refusal.message, refusal.missing);
    throw new Error(result.error ?? "The re-entry was not saved.");
  }
  return {
    state: result.state ?? null,
    revertible: result.revertible ?? String(body.commandId),
    unrecorded: result.result?.unrecorded ?? 0,
    lapsed: result.result?.lapsed ?? 0
  };
}

/** Puts the lapsed pulse and the unsettled items back, through the same undo the agents' writes use. */
export async function postRevert(target: string): Promise<PortalState | null> {
  const response = await fetch("/api/commands/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: createClientId(), target, direction: "undo" })
  });
  const body = (await response.json().catch(() => ({}))) as { state?: PortalState; error?: string };
  if (!response.ok) throw new Error(body.error ?? "The undo was not applied.");
  return body.state ?? null;
}
