"use client";

import { useMemo } from "react";
import { extensionUnreadRows } from "@/state/extensions";
import { usePortal } from "@/state/portal-provider";
import { isKeptForLater } from "@/features/capture/capture-commands";
import { groupEmailThreads, isEmailThreadChange } from "@/features/capture/email-threads";
import { calendarsWaiting, useCalendarReviewCount } from "@/features/calendar-sync/calendar-review-count";
import { usePlanMapOpenCount } from "@/features/plan-map/plan-map-open-count";
import { pendingAgentProposals, useAgentProposals } from "@/features/agent-proposals/agent-proposals-store";
import type { CaptureItem } from "@/state/portal-state";
import type { RoomCounts } from "./rooms";

/**
 * The room counts from what the rooms themselves list. Emails counts the thread cards the room shows,
 * grouped from portal state like the room groups them, rather than the server's review count: that
 * one is read on its own clock (load, focus, five minutes), so between reads the badge and the cards
 * could disagree.
 */
export function countRooms(input: {
  captures: readonly CaptureItem[];
  peopleUnread: number;
  agentPending: number;
  calendar: number;
  map: number;
}): RoomCounts {
  const pending = input.captures.filter((item) => item.status === "pending");
  const emailItems = pending.filter(isEmailThreadChange);
  return {
    emails: groupEmailThreads(emailItems).length,
    people: input.peopleUnread,
    captured: pending.length - emailItems.length + input.agentPending,
    calendar: input.calendar,
    map: input.map,
    kept: input.captures.filter(isKeptForLater).length
  };
}

/**
 * Every room's count, from portal state (emails, captures, notes from people), the agent proposals
 * store, and the stores the shell keeps fresh for what portal state does not carry (the calendar review
 * count, the plan map's open count). One hook, so the rail's badge, the phone tab's badge and the
 * Inbox's own tabs cannot disagree. Captured also counts the writes agents proposed and are waiting
 * for a decision.
 */
export function useRoomCounts(): RoomCounts {
  const { state, extensions } = usePortal();
  // One row per calendar with events held, as the queue lists them, not one per event.
  const calendar = calendarsWaiting(useCalendarReviewCount()).length;
  const map = usePlanMapOpenCount();
  const agentPending = pendingAgentProposals(useAgentProposals()).length;
  // Rows with something unread, one per card in From people, rather than unread messages: a note
  // and its follow-up are one thing to read.
  const peopleUnread = useMemo(() => extensionUnreadRows(extensions), [extensions]);
  return useMemo(
    () => countRooms({ captures: state.captures, peopleUnread, agentPending, calendar, map }),
    [state.captures, peopleUnread, agentPending, calendar, map]
  );
}
