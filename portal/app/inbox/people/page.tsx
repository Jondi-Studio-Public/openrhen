"use client";

import { InboxQueue } from "@/features/inbox/components/inbox-queue";

/** The Inbox queue with the People chip on. */
export default function InboxPeoplePage() {
  return <InboxQueue filter="people" />;
}
