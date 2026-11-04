import type { PlanningEntityCommand } from "@openrhen/contracts";
import { createClientId } from "@/shared/client-id";

/**
 * The write side of `/sleep`, posted straight at the existing generic entity-command endpoint —
 * there is nothing this surface needs from `usePortal()`'s save path (its state update folds in the
 * portal's own narrower sleep window, which is exactly what this surface must not merge with). One
 * `send` mirrors the try/fetch/throw shape `ManualSleepEntry.send()` already uses, so a rejected
 * command surfaces the server's own message rather than a generic one.
 */
async function send(entity: Record<string, unknown>, expectedVersion: number | null, failure: string): Promise<void> {
  const command: PlanningEntityCommand = {
    commandId: createClientId(),
    expectedVersion,
    type: "save_entity",
    entityType: "sleep_log_entry",
    entity
  };
  const response = await fetch("/api/commands/entity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command)
  });
  const result = (await response.json().catch(() => ({}))) as { state?: unknown; error?: string };
  if (!response.ok || !result.state) throw new Error(result.error ?? failure);
}

/** A night the app never saw. `sleepAt` and `wakeAt` are instants (`Date#toISOString()`). */
export function createNight(sleepAt: string, wakeAt: string): Promise<void> {
  return send({ sleepAt, wakeAt }, null, "The night was not saved.");
}

/**
 * Corrects an existing night. `wakeAt` is omitted for a night still in progress — the server does
 * not accept a wake time for one, and Now's "I'm awake" is the only way to close it out.
 */
export function updateNight(
  id: string,
  expectedVersion: number | null,
  sleepAt: string,
  wakeAt?: string
): Promise<void> {
  return send({ id, sleepAt, ...(wakeAt ? { wakeAt } : {}) }, expectedVersion, "The night was not saved.");
}

export function deleteNight(id: string, expectedVersion: number | null): Promise<void> {
  return send({ id, remove: true }, expectedVersion, "The night was not removed.");
}
