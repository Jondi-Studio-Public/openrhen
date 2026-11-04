"use client";

import { InboxQueue } from "@/features/inbox/components/inbox-queue";

/** `/inbox` itself: every item that waits, in one queue. */
export default function InboxPage() {
  return <InboxQueue filter="all" />;
}
