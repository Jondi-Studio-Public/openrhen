import type { CheckInCommand } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";

/**
 * Answers one check-in slot, posted straight at its own command endpoint rather than through
 * `usePortal()`'s save path — an answer never touches the plan (Phase A is record-only), so it must
 * not trigger that path's `followPlanRefresh` poll, which exists for commands that do. Mirrors
 * `sleep-log-command.ts`'s `send()` shape for the same reason that surface bypasses it.
 */
async function send(command: CheckInCommand): Promise<void> {
  const response = await fetch("/api/commands/check-in", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  const result = (await response.json().catch(() => ({}))) as { state?: unknown; error?: string };
  if (!response.ok || !result.state) throw new Error(result.error ?? "The check-in was not saved.");
}

export function answerOnTrack(
  checkInId: string,
  expectedVersion: number | null,
  answerSource: "in_app_banner" | "sheet"
): Promise<void> {
  return send({
    commandId: createClientId(),
    expectedVersion,
    type: "answer_check_in",
    checkInId,
    status: "on_track",
    answerSource
  });
}

/**
 * Records "Not sure" — the same `unknown` status the scheduler itself writes on a silent timeout, but
 * here it means the opposite: the person said something, just not which way. Neither counted for nor
 * against adherence (`readCheckInSummary` only tallies `on_track`/`deviated` as answered), and it
 * closes out the slot the same as any other answer so the banner does not keep re-showing it.
 */
export function answerUnsure(
  checkInId: string,
  expectedVersion: number,
  answerSource: "in_app_banner" | "sheet"
): Promise<void> {
  return send({
    commandId: createClientId(),
    expectedVersion,
    type: "answer_check_in",
    checkInId,
    status: "unknown",
    answerSource
  });
}

export function answerDeviated(
  checkInId: string,
  expectedVersion: number,
  deviation: { category?: "work" | "family" | "life_admin" | "other"; note?: string; targetId?: string },
  answerSource: "in_app_banner" | "sheet"
): Promise<void> {
  return send({
    commandId: createClientId(),
    expectedVersion,
    type: "answer_check_in",
    checkInId,
    status: "deviated",
    ...(deviation.category ? { deviationCategory: deviation.category } : {}),
    ...(deviation.note?.trim() ? { deviationNote: deviation.note.trim() } : {}),
    ...(deviation.targetId ? { deviationTargetId: deviation.targetId } : {}),
    answerSource
  });
}
