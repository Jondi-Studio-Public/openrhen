import { useCallback, useRef, useState } from "react";

/**
 * Per-button pending for the actions that must feel instant.
 *
 * The portal's global `saving` flag disables a whole page while any command runs, so a second press waits for the
 * first one's round trip. A guarded press instead disables only its own button, and only while its own command is
 * in flight: `press(key, run)` ignores a repeat of the same key (the double tap that would otherwise send the same
 * change twice) and leaves every other key, and every other button, free. The provider queues the commands behind
 * it, so presses on different keys still reach the server one at a time, in the order they were made.
 *
 * `run` may throw or reject: the provider has already put the reason on its banner, so the guard only releases the
 * key and never rethrows into an event handler.
 */
export function usePressGuard() {
  const inFlight = useRef<Set<string>>(new Set());
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());

  const press = useCallback((key: string, run: () => Promise<unknown> | unknown): Promise<void> => {
    if (inFlight.current.has(key)) return Promise.resolve();
    inFlight.current.add(key);
    setPending(new Set(inFlight.current));
    // Called straight away, not a microtask later: a press is a user gesture and its command should leave now.
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(run());
    } catch (error) {
      started = Promise.reject(error);
    }
    return started
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        inFlight.current.delete(key);
        setPending(new Set(inFlight.current));
      });
  }, []);

  const isPending = useCallback((key: string) => pending.has(key), [pending]);
  return { press, isPending };
}
