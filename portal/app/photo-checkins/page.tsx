"use client";

import { PhotoCheckinPage } from "@/features/photo-checkins/components/photo-checkin-page";

/** `/photo-checkins`: capture and trail for the photo and voice check-ins, in `features/photo-checkins/`. */
export default function PhotoCheckinsRoute() {
  return (
    <main className="content-page">
      <p className="eyebrow">You</p>
      <h1>Photo check-ins</h1>
      <p className="reason">Show what you are doing.</p>
      <PhotoCheckinPage />
    </main>
  );
}
