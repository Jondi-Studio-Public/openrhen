"use client";

import { InboxQueue } from "@/features/inbox/components/inbox-queue";

/** The Inbox queue with the Captured chip on. */
export default function InboxCapturedPage() {
  return <InboxQueue filter="captured" />;
}
