"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { openCaptureSheet } from "@/shared/use-capture-sheet";
import { consumeCaptureHash } from "../use-add-sheet";

/**
 * The Inbox's way in. There is one sheet for adding things, the shell's `+` sheet; this button opens
 * it, so a thought, pasted text or a photo, a workbook or a calendar provider pull is added the same way from
 * here as from anywhere. `/inbox#capture`, the old address of the intake panels, opens it too.
 */
export function AddSheet() {
  const pathname = usePathname();

  // The hash is dropped straight away so closing the sheet, or a redirect to a room, does not reopen it.
  useEffect(() => {
    if (!consumeCaptureHash()) return;
    // Opened a tick later, so the sheet sees a plain closed-to-open change rather than one landing in
    // the middle of hydration, where it can be missed.
    setTimeout(() => openCaptureSheet("capture"), 0);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, [pathname]);

  return (
    <Button variant="secondary" onClick={() => openCaptureSheet("capture")}>
      Add or import
    </Button>
  );
}
