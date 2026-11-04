"use client";

import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";

/**
 * What the shell shows in the page's place when the first read of the plan failed: the navigation and
 * Capture stay, so it is never a dead end, and no page renders over state that was never loaded.
 */
export function PlanNotLoaded({ onRetry = () => window.location.reload() }: { onRetry?: () => void }) {
  return (
    <main className="content-page">
      <EmptyState
        titleAs="h1"
        title="Your plan isn't showing"
        body="The database didn't answer, so there is nothing real to show yet. Nothing has been changed or lost."
        action={
          <Button variant="primary" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    </main>
  );
}
