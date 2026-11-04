"use client";

import { useEffect } from "react";

/**
 * The app-router error boundary for everything under the root layout — the nav, the tab bar, and the
 * portal provider all keep running; only the page that threw is replaced with this. A render throw
 * anywhere below here used to blank the whole app rather than being caught anywhere.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main className="content-page">
      <p className="eyebrow">Something went wrong</p>
      <h1>This page hit a snag.</h1>
      <p className="reason">Nothing here was saved or lost — the page just failed to show.</p>
      <div className="actions">
        <button onClick={() => reset()}>Try again</button>
      </div>
    </main>
  );
}
