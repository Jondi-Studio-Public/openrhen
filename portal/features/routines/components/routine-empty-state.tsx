"use client";

/** Shown while nothing is open, so the first thing on screen is the way in rather than a blank panel. */
export function RoutineEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="routine-empty-state">
      <div aria-hidden="true">◇ → ◇ → ◆</div>
      <h2>Choose or create a routine</h2>
      <p>Pick one from the list to edit it, or start a new one.</p>
      <button type="button" onClick={onCreate}>
        New routine
      </button>
    </div>
  );
}
