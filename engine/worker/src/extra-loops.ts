import type { Sql } from "postgres";
import type { LoopStep } from "./independent-loops.js";

/**
 * Registry of worker loops that the core worker does not ship (P4-08 and P4-13, the seam rule in
 * the design notes). A build that has such a loop lists it in `private/index.ts`, which registers
 * it on import; the OpenRhen export excludes that folder and ships an empty `private/index.ts`, so the core
 * worker runs none. `main.ts` wraps every registered loop in `afterPortalReady` like its own portal-facing ticks.
 */
export interface WorkerLoopContext {
  portalInternalUrl: string | undefined;
  workerId: string;
  portalHeaders: (extra?: Record<string, string>) => Record<string, string>;
  positiveInteger: (value: string | undefined, defaultValue: number) => number;
  /** The worker's database connection, for a loop that reads or queues rows of its own. */
  sql: Sql;
  /** The owner's timezone from Settings, re-read each minute. */
  ownerTimezone: () => Promise<string>;
  /** A `HH:MM` setting from the environment; an invalid value is logged and the fallback used. */
  configuredLocalTime: (name: string, fallback: string) => string;
}

export interface ExtraLoop {
  /** Stable name, unique across loops; registering one twice is a no-op. */
  name: string;
  /** Builds the loop's step once at boot. Logs its own "disabled" line when it will not run. */
  create(context: WorkerLoopContext): LoopStep;
}

const loops = new Map<string, ExtraLoop>();

export function registerExtraLoop(loop: ExtraLoop): void {
  if (!loops.has(loop.name)) loops.set(loop.name, loop);
}

export function extraLoopSteps(context: WorkerLoopContext): LoopStep[] {
  return [...loops.values()].map((loop) => loop.create(context));
}
