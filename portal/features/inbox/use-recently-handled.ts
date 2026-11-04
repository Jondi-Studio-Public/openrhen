"use client";

import { useMemo } from "react";
import { useNow } from "@/shared/clock";
import { usePortal } from "@/state/portal-provider";
import type { CaptureItem } from "@/state/portal-state";
import { isEmailThreadChange } from "@/features/capture/email-threads";
import { mailSource } from "@/state/extensions";
import { isKeptForLater } from "@/features/capture/capture-commands";
import { proposalTypeLabel } from "./proposal-type-label";
import { isWithinHandledWindow, newestFirst, type HandledRow } from "@/shared/recently-handled";

export { proposalTypeLabel };

export interface HandledByRoom {
  emails: HandledRow[];
  captured: HandledRow[];
  kept: HandledRow[];
}

const isKeptType = (item: CaptureItem) => item.proposalType === "someday" || item.proposalType === "reference";

function rowFor(item: CaptureItem): HandledRow {
  const title = typeof item.proposedFields.title === "string" ? item.proposedFields.title : item.text;
  return {
    id: item.id,
    title,
    detail: `${proposalTypeLabel(item.proposalType)} · the original is kept`,
    outcome: item.status,
    at: item.reviewedAt ?? item.createdAt
  };
}

/**
 * Splits the proposals confirmed or ignored in the last seven days between the rooms they were
 * handled in. A thread change belongs to Emails. A Someday or Reference item that was dropped belongs
 * to Someday & reference, while one that is still filed stays in that room's own list rather than
 * appearing here as handled. Everything else was handled in Captured. A proposal captured days ago
 * but only just decided counts from the decision, never from the capture.
 */
export function splitHandled(captures: readonly CaptureItem[], now: number): HandledByRoom {
  const out: HandledByRoom = { emails: [], captured: [], kept: [] };
  for (const item of captures) {
    if (item.status !== "confirmed" && item.status !== "ignored") continue;
    if (!isWithinHandledWindow(item.reviewedAt ?? item.createdAt, now)) continue;
    if (isEmailThreadChange(item)) out.emails.push(rowFor(item));
    else if (isKeptForLater(item)) continue;
    else if (item.status === "ignored" && isKeptType(item)) out.kept.push(rowFor(item));
    else out.captured.push(rowFor(item));
  }
  return { emails: newestFirst(out.emails), captured: newestFirst(out.captured), kept: newestFirst(out.kept) };
}

/** A superseded proposal of the registered mail source (a reasoned thread's change, or an older extraction's). */
const isMailProposal = (item: CaptureItem) => Boolean(mailSource()?.ownsProposal(item));

/**
 * The mail proposals a later reading of the mail replaced in the last seven days, newest first, for
 * the Emails room's Replaced list. They counted as waiting until then; each can be restored. A
 * replacement is dated from `reviewedAt`, which the ingest stamps when it supersedes; an older one with
 * no stamp falls back to the capture date, as the handled lists do.
 */
export function splitReplaced(captures: readonly CaptureItem[], now: number): HandledRow[] {
  const rows: HandledRow[] = [];
  for (const item of captures) {
    if (item.status !== "superseded" || !isMailProposal(item)) continue;
    if (!isWithinHandledWindow(item.reviewedAt ?? item.createdAt, now)) continue;
    rows.push({
      id: item.id,
      title: typeof item.proposedFields.title === "string" ? item.proposedFields.title : item.text,
      detail: `${proposalTypeLabel(item.proposalType)} · replaced by a newer suggestion from the same thread`,
      outcome: "replaced",
      at: item.reviewedAt ?? item.createdAt
    });
  }
  return newestFirst(rows);
}

export function useRecentlyReplaced(): HandledRow[] {
  const { state } = usePortal();
  const now = useNow("minute");
  return useMemo(() => splitReplaced(state.captures, now.getTime()), [state.captures, now]);
}

export function useRecentlyHandled(): HandledByRoom {
  const { state } = usePortal();
  const now = useNow("minute");
  return useMemo(() => splitHandled(state.captures, now.getTime()), [state.captures, now]);
}
