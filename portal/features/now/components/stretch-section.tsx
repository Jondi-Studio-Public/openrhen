"use client";

import type { StretchBlock, StretchOfferAnswer } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { fetchState, postStretch, undoStretch } from "@/features/now/stretch-client";
import { StretchCard } from "./stretch-card";

/**
 * Connects the card to the portal: an answer or an undo returns the fresh state, which is adopted at once so the
 * offer gives way to the active line (or comes back after Undo) without waiting for the next poll.
 */
export function StretchSection({
  offer,
  stretch,
  timezone
}: {
  offer: StretchOfferAnswer | null;
  stretch: StretchBlock | null;
  timezone: string;
}) {
  const { acceptServerState } = usePortal();
  return (
    <StretchCard
      offer={offer}
      stretch={stretch}
      timezone={timezone}
      answer={async (body) => {
        const done = await postStretch(body);
        if (done.state) acceptServerState(done.state);
        return done;
      }}
      refresh={async () => {
        const fresh = await fetchState();
        if (fresh) acceptServerState(fresh);
      }}
      undo={async (revertible) => {
        const next = await undoStretch(revertible);
        if (next) acceptServerState(next);
      }}
    />
  );
}
