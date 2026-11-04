/**
 * A trailing debounce that cannot be postponed for ever: `trigger()` restarts the `quietMs` timer, but
 * only until `maxWaitMs` after the first trigger of a burst, after which the pending call is left to
 * fire. A plain debounce lets a steady stream of triggers (one every few hundred milliseconds) hold the
 * call off for as long as the stream lasts.
 */
export function createMaxWaitDebounce(
  run: () => void,
  options: { quietMs: number; maxWaitMs: number },
  now: () => number = Date.now
): { trigger(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let burstStartedAt = 0;
  return {
    trigger() {
      const at = now();
      if (timer) {
        if (at - burstStartedAt >= options.maxWaitMs) return;
        clearTimeout(timer);
      } else {
        burstStartedAt = at;
      }
      timer = setTimeout(() => {
        timer = null;
        run();
      }, options.quietMs);
    }
  };
}
