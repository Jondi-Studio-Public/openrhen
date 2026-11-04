import type { ReactNode } from "react";
import { InboxProvider } from "@/features/inbox/inbox-provider";
import { InboxFrame } from "@/features/inbox/components/inbox-frame";

/**
 * Every Inbox room shares one provider, so a proposal under review, a batch being previewed and the
 * counts on the tabs survive a move between rooms.
 */
export default function InboxLayout({ children }: { children: ReactNode }) {
  return (
    <InboxProvider>
      <InboxFrame>{children}</InboxFrame>
    </InboxProvider>
  );
}
