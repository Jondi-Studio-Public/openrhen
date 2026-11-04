"use client";

import { InboxQueue } from "@/features/inbox/components/inbox-queue";

/** The Inbox queue with the Calendar chip on. */
export default function InboxCalendarPage() {
  return <InboxQueue filter="calendar" />;
}
