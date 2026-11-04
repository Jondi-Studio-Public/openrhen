import type { DisruptionField } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";
import type { PortalState } from "@/state/portal-state";

/** A refused disruption: the server's sentence and each field it still needs, by name. */
export class DisruptionRefusedError extends Error {
  constructor(
    message: string,
    readonly missing: DisruptionField[]
  ) {
    super(message);
  }
}

export interface DisruptionDone {
  state: PortalState | null;
  /** The command id `postRevert` takes; null for an end that could not name one. */
  revertible: string | null;
  ended: boolean;
  doing: string;
  until: string;
}

/** Records a disruption, or with `{ end: true }` ends the one in force. */
export async function postDisruption(body: Record<string, unknown>): Promise<DisruptionDone> {
  const response = await fetch("/api/commands/pulse-disruption", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = (await response.json().catch(() => ({}))) as {
    code?: string;
    error?: string;
    missing?: DisruptionField[];
    state?: PortalState;
    revertible?: string;
    result?: { ended?: boolean; doing?: string | null; until?: string | null };
  };
  if (!response.ok) {
    if (result.code === "disruptionIncomplete")
      throw new DisruptionRefusedError(result.error ?? "The disruption is incomplete.", result.missing ?? []);
    throw new Error(result.error ?? "The disruption was not saved.");
  }
  return {
    state: result.state ?? null,
    revertible: result.revertible ?? null,
    ended: result.result?.ended ?? false,
    doing: result.result?.doing ?? "",
    until: result.result?.until ?? ""
  };
}

export function endDisruptionBody(): Record<string, unknown> {
  return { commandId: createClientId(), end: true, basis: "stated", evidence: "Ended on Now" };
}

/**
 * The command id for submitting this form content: the same id while the content is unchanged, so a retry after a
 * dropped response replays instead of recording twice. Call `forgetCommandId` after a success.
 */
export function retryableCommandId(slot: { current: { key: string; id: string } | null }, key: string): string {
  if (!slot.current || slot.current.key !== key) slot.current = { key, id: createClientId() };
  return slot.current.id;
}
