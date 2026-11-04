"use client";

import { InboxQueue } from "@/features/inbox/components/inbox-queue";

/** The Inbox queue with the Map chip on. */
export default function InboxMapPage() {
  return <InboxQueue filter="map" />;
}
