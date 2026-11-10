import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What the server did with the time an owner's device claimed for a command (`occurredAt`), said in words for the
 * reply. One per request, noted by the command handler and read by the route that answers.
 */
export interface OccurredAtReport {
  /** The time the owner's device claimed, as received. */
  claimedAt: string;
  /** True when the command took effect at `appliedAt` = the claimed time (a time inside the grace is held at receipt). */
  applied: boolean;
  /** When the command took effect: the claimed time, or the moment the server received it. */
  appliedAt: string;
  /** Present when the claimed time was recorded but not used: the reason, in words. */
  reason?: string;
  /** What to show the owner. */
  message: string;
  /** Set when the command did nothing because its target had closed, and the words were kept elsewhere. */
  delivered?: boolean;
}

const storage = new AsyncLocalStorage<{ report: OccurredAtReport | null }>();

/** Runs `fn` and returns what it noted, so a route can put the sentence in the reply. */
export async function collectOccurredAtReport<T>(
  fn: () => Promise<T>
): Promise<{ value: T; report: OccurredAtReport | null }> {
  const holder: { report: OccurredAtReport | null } = { report: null };
  const value = await storage.run(holder, fn);
  return { value, report: holder.report };
}

/** Notes the outcome for the request in scope; a call made outside a collecting route is ignored. */
export function noteOccurredAtReport(report: OccurredAtReport): void {
  const holder = storage.getStore();
  if (holder) holder.report = report;
}
