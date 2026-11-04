"use client";

import { CatchUpPage } from "@/features/catch-up/components/catch-up-page";

/**
 * `/catch-up`: settle what was planned while you were away. Opened from the
 * banner on Now when a catch-up is due.
 */
export default function CatchUpRoute() {
  return (
    <main className="content-page">
      <h1>Catch up</h1>
      <p className="reason">Settle what happened while you were away.</p>
      <CatchUpPage />
    </main>
  );
}
