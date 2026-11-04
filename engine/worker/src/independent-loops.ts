/**
 * Runs each step in its own serial loop, so a slow step only ever delays itself. The worker's
 * steps used to share one loop, where a daily sync waiting out its five-minute timeout held every
 * plan-forecast job — and so every "plan is refreshing" in the portal — behind it.
 *
 * Each loop awaits its own step before sleeping and running it again, which is the overlap guard: a
 * step is never started while its previous run is still going. A step that throws is reported and the
 * loop carries on; nothing one step does can stop another. `idleDelayMs` is the pause after a step
 * reports it had nothing to do (`"idle"`) or returned nothing; a step that did work runs again at once.
 */
export interface LoopStep {
  name: string;
  run: () => Promise<unknown>;
}

export function runIndependentLoops(
  steps: LoopStep[],
  options: {
    isStopping: () => boolean;
    onError: (name: string, error: unknown) => void;
    idleDelayMs?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }
): Promise<void> {
  const idleDelayMs = options.idleDelayMs ?? 1_000;
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return Promise.all(
    steps.map(async ({ name, run }) => {
      while (!options.isStopping()) {
        let outcome: unknown;
        try {
          outcome = await run();
        } catch (error) {
          options.onError(name, error);
        }
        if (outcome === undefined || outcome === "idle") await sleep(idleDelayMs);
      }
    })
  ).then(() => undefined);
}
