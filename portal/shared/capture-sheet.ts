/**
 * What the global `+` sheet is open for.
 *
 * Two different acts arrive through the same button. A capture is a thought got out of the way: it
 * waits under Needs review and changes nothing. A disruption has already taken the time, so it is
 * written as a real commitment and the day is replanned around it. They share the sheet because they
 * are both "something just occurred to me", and they are separated inside it because confusing them
 * would either bury a real event in a review queue or let a stray thought rearrange the day.
 *
 * The sheet is also the one way to bring things in: pasted text or a photo, a workbook or CSV, and any
 * provider pull a registered extension adds are further tabs of it. They end as a proposal or a held import batch, never as a
 * change to the plan.
 *
 * Unlike the view mode, nothing here is remembered: which half was last used says nothing about what
 * the next interruption will be, and a sheet that reopens in the other mode than the button promised
 * is worse than one that always starts where it was asked to.
 */
export type CaptureSheetMode = "capture" | "paste" | "workbook" | "disruption" | (string & Record<never, never>);

export interface CaptureSheetState {
  open: boolean;
  mode: CaptureSheetMode;
  /**
   * Set only when the disruption half was opened from a **Let someone know?** offer
   * the contact to pre-choose, when one resolved, and a line
   * naming the commitment the offer came from. Cleared by switching halves or closing the sheet, the
   * same way the sheet itself is never remembered across an open. `reason` and `lateMinutes` say why
   * the offer was made, so the prefilled message can say it too.
   */
  disruptionPreset?: DisruptionPreset;
}

export interface DisruptionPreset {
  contactId?: string;
  about?: string;
  reason?: "late" | "displaced" | "cancelled";
  lateMinutes?: number;
}

/** The closed sheet, as one shared value so a snapshot only changes identity when the sheet does. */
export const CLOSED_CAPTURE_SHEET: CaptureSheetState = { open: false, mode: "capture" };

/** What the sheet calls itself in each mode. */
export function captureSheetTitle(mode: CaptureSheetMode): string {
  if (mode === "disruption") return "Something came up";
  return mode === "capture" ? "Capture" : "Add or import";
}
