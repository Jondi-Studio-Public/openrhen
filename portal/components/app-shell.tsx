"use client";

import { useEffect, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { usePortal } from "@/state/portal-provider";
import { useNow } from "@/shared/clock";
import { planTime } from "@/features/planning/plan-banner";
import { closeCaptureSheet, openCaptureSheet } from "@/shared/use-capture-sheet";
import { AppNav } from "./app-nav";
import { ImportWorkflowProvider } from "@/features/imports/import-workflow-provider";
import { CaptureSheetDialog } from "./capture-sheet-dialog";
import { PlanNotLoaded } from "./plan-not-loaded";
import styles from "./app-shell.module.css";
import { GoToPalette } from "./go-to-palette";
import { useEmailReviewCountRefresh } from "@/features/capture/email-review-count";
import { useAgentProposalsRefresh } from "@/features/agent-proposals/agent-proposals-store";
import { useCalendarReviewCountRefresh } from "@/features/calendar-sync/calendar-review-count";
import { usePlanMapOpenCountRefresh } from "@/features/plan-map/plan-map-open-count";
import { useRoomCounts } from "@/features/inbox/use-room-counts";
import { inboxBadge } from "@/features/inbox/rooms";
import { useConnectionLapses } from "@/features/connections/connection-lapses";
import { CloseToastRegion } from "@/features/closed/components/close-toast";

/**
 * Frames every page: the side rail on a desk, the bottom tab bar on a phone, the Go to palette, and the global `+` capture sheet. Pages render their own `<main>` inside `.app-content`, which
 * reserves room for the tab bar so nothing hides behind it and clips horizontal overflow so no page
 * can widen the layout viewport.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { state, loadFailed } = usePortal();
  useCalendarReviewCountRefresh();
  useEmailReviewCountRefresh();
  useAgentProposalsRefresh();
  usePlanMapOpenCountRefresh();
  // Everything that needs a decision badges the tab: threads with changes to review (waiting mail
  // needs nothing from you yet), notes from other people, captured proposals, calendar events held for
  // review, and plan map suggestions. Kept items are filed, not waiting.
  const inboxCount = inboxBadge(useRoomCounts());
  const youAlert = useConnectionLapses().lapsed.length > 0;
  // The rail's foot names the plan on screen by when it was worked out, so a page that looks wrong
  // can be read against how old its plan is. Moves by the minute, for the "Mon" a day later.
  const clock = useNow("minute");
  const lastPlan = state.planning?.lastSuccessfulAt;
  const planUpdated = lastPlan ? planTime(lastPlan, state.settings.timezone, clock) : null;
  const openCapture = () => openCaptureSheet("capture");
  // A route change closes the sheet, so it never stays open over a page it was not opened from.
  useEffect(() => closeCaptureSheet(), [pathname]);
  // A failed first read leaves no real counts to show, so the Inbox tab wears none.
  const badge = loadFailed ? 0 : inboxCount;

  // First run is a bare page: one task, no navigation to wander off into before there is a plan.
  // Setup's own "Back to Now" and "Skip for now" are the way out.
  if (isBarePath(pathname)) return <BareShell loadFailed={loadFailed}>{children}</BareShell>;

  return (
    <ImportWorkflowProvider>
      <div className="app-shell">
        {/* First in the tab order, so a keyboard can step past the navigation; hidden until focused. */}
        <a className="skip-link" href="#content">
          Skip to content
        </a>
        <AppNav
          variant="rail"
          pathname={pathname}
          onCapture={openCapture}
          inboxCount={badge}
          youAlert={youAlert}
          planUpdated={planUpdated}
        />
        <div className="app-content" id="content" tabIndex={-1}>
          {loadFailed ? <PlanNotLoaded /> : children}
        </div>
        <AppNav variant="tabs" pathname={pathname} onCapture={openCapture} inboxCount={badge} youAlert={youAlert} />
        <GoToPalette />
        <CaptureSheetDialog />
        {/* Mounted here, not in a page, so the Undo after a close survives the navigation the close often causes. */}
        <CloseToastRegion />
      </div>
    </ImportWorkflowProvider>
  );
}

/** Paths drawn without the navigation, the Go to palette or Capture. */
export function isBarePath(pathname: string | null): boolean {
  return pathname === "/setup";
}

/**
 * A bare page's shell: the page alone, with the same guard as every other page, so a first read that
 * failed never lets setup save over state that was never loaded.
 */
export function BareShell({ loadFailed, children }: { loadFailed: boolean; children: ReactNode }) {
  return (
    <div className={`app-shell ${styles.bare}`}>
      <div className="app-content" id="content" tabIndex={-1}>
        {loadFailed ? <PlanNotLoaded /> : children}
      </div>
    </div>
  );
}
