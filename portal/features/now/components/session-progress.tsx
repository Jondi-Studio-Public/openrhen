/**
 * How far through the planned time a running session is, as a thin bar under the countdown. Drawn
 * with `transform: scaleX()` and a one-second linear transition, so it moves continuously between
 * ticks without any layout work. Full, in the overtime colour, once the planned time has passed.
 */
export function SessionProgress({
  secondsRemaining,
  plannedMinutes
}: {
  secondsRemaining: number;
  plannedMinutes: number;
}) {
  const total = plannedMinutes * 60;
  if (!(total > 0)) return null;
  const fraction = Math.min(1, Math.max(0, 1 - secondsRemaining / total));
  const percent = Math.round(fraction * 100);
  return (
    <div
      className={`session-progress${secondsRemaining < 0 ? " overtime" : ""}`}
      role="progressbar"
      aria-label="Time used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <span style={{ transform: `scaleX(${fraction})` }} />
    </div>
  );
}
