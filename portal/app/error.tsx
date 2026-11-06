"use client";

import Link from "next/link";
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
      <p className="reason">
        The page failed to show. Anything you had already saved is safe; anything you were typing may not be. Try again,
        or go back to Now.
      </p>
      {error.digest && <p className="hint">Reference {error.digest}. Quote it if you report this.</p>}
      <div className="actions">
        <button onClick={() => reset()}>Try again</button>
        <Link href="/">Go to Now</Link>
      </div>
    </main>
  );
}
