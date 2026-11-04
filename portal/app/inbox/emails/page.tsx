"use client";

import { notFound } from "next/navigation";
import { InboxQueue } from "@/features/inbox/components/inbox-queue";
import { mailSource } from "@/state/extensions";

/** The Inbox queue with the Emails chip on; there is no such address while no mail provider is installed. */
export default function InboxEmailsPage() {
  if (mailSource() === undefined) notFound();
  return <InboxQueue filter="emails" />;
}
