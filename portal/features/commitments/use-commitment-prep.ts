"use client";

import { useMemo } from "react";
import { usePortal } from "@/state/portal-provider";
import { cancelPrep, openPrepOf } from "@/features/commitments/cancel-prep";

/**
 * The open prep of the commitment being edited, and the move that cancels it, for the commitment
 * editor's "Cancel its open prep too?" offer. Reads the prep at the moment of the click, not when the
 * editor opened, so prep finished in between is not cancelled.
 */
export function useCommitmentPrep(commitmentId: string) {
  const { state, saveActionCommand } = usePortal();
  const openPrep = useMemo(() => openPrepOf(state.actions, commitmentId), [state.actions, commitmentId]);
  return {
    openPrep: openPrep.map((action) => ({ id: action.id, title: action.title })),
    onCancelPrep: () => cancelPrep(openPrep, saveActionCommand)
  };
}
