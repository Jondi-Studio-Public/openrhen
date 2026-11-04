"use client";

import { InboxQueue } from "@/features/inbox/components/inbox-queue";

/** The Inbox queue with the Kept chip on. */
export default function InboxKeptPage() {
  return <InboxQueue filter="kept" />;
}
