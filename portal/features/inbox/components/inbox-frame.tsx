"use client";

import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useInbox } from "../inbox-provider";
import { DecisionToast } from "./decision-toast";

/**
 * The Inbox's page, shared by every chip: the decision toast lives here so it survives a chip
 * change, and the import upload key remounts the page after an upload.
 */
export function InboxFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { imports, decisions } = useInbox();
  const dismissToast = decisions.dismiss;
  // The toast speaks for the chip it was raised under; its "View in Recently handled" would open another's.
  useEffect(() => dismissToast(), [pathname, dismissToast]);
  return (
    <main key={imports.uploadKey} className="content-page inbox-page">
      {children}
      <DecisionToast toast={decisions.toast} onDismiss={decisions.dismiss} />
    </main>
  );
}
