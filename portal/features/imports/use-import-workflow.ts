"use client";

import { useEffect, useRef, useState } from "react";
import type { ImportBatch } from "@openrhen/contracts";
import { usePortal } from "@/state/portal-provider";
import { downloadImportErrors } from "@/features/imports/import-downloads";
import { requestImportBatch } from "@/features/imports/import-requests";
import { useImportCommit } from "./use-import-commit";
import { useImportIntake } from "./use-import-intake";
import { useImportQueue } from "./use-import-queue";
import { useImportReview } from "./use-import-review";
import { useImportStatus, type ImportStatusScope } from "./use-import-status";

/**
 * Everything the Import centre used to hold in its page, composed from four concerns that each hold
 * their own state: intake (`useImportIntake`), the batch under review (`useImportReview`), moving it
 * forward (`useImportCommit`), and the queue of open batches (`useImportQueue`), over one set of
 * status lines (`useImportStatus`). It lives in a hook so the Inbox can lay the same behaviour out
 * differently on a phone and a desk without the page owning any of it, and returns one flat shape so
 * the components need not know which concern answers.
 */
export function useImportWorkflow() {
  const { state, acceptServerState, saveEntityCommand } = usePortal();
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const status = useImportStatus();
  const review = useImportReview(state, batch, setBatch, saveEntityCommand);

  // What is on screen right now, for a reply that lands after the screen has moved on.
  const latest = useRef<{ id: string | null; pendingEdits: boolean }>({ id: null, pendingEdits: false });
  useEffect(() => {
    latest.current = { id: batch?.id ?? null, pendingEdits: review.pendingEdits };
  });

  /** A batch the server has just returned becomes the one under review and is reflected in the queue. */
  const receiveBatch = (next: ImportBatch) => {
    setBatch(next);
    review.markSaved();
    queue.reconcile(next);
  };

  const queue = useImportQueue({
    status,
    currentBatchId: batch?.id ?? null,
    receiveBatch: (next) => {
      receiveBatch(next);
      review.setFilter("all");
    },
    closeBatch: review.closeBatch
  });

  const intake = useImportIntake({
    timezone: state.settings.timezone,
    status,
    receiveBatch,
    clearBatch: () => setBatch(null)
  });

  const commit = useImportCommit({
    batch,
    status,
    acceptServerState,
    receiveBatch,
    reconcileQueue: queue.reconcile,
    afterCommit: (full) => {
      review.closeBatch();
      if (full) intake.resetAi();
      intake.resetUpload();
    }
  });

  /**
   * The batch under review is kept while you are away from the Inbox, so on coming back it may be
   * older than the server's copy (the CLI or another browser changed it). Reloads it, unless you have
   * edits here that the server has not seen: those win until saved or discarded. A failed read keeps
   * what is on screen.
   */
  const refreshOpenBatch = async () => {
    if (!batch || review.pendingEdits) return;
    const asked = batch.id;
    try {
      const fresh = await requestImportBatch(asked);
      // The reply is the server's copy as of the ask. If the batch was closed or another one opened
      // meanwhile, or edits were made, it must not bring back or replace what is on screen now.
      if (latest.current.id !== asked || latest.current.pendingEdits) return;
      receiveBatch(fresh);
    } catch {
      // The copy on screen is still the best there is.
    }
  };

  /**
   * One error and one notice at a time, shown where they were raised. Each panel asks for its own
   * scope and gets nothing when the current message belongs to another part of the page, so a
   * failed upload never appears beside the commit button.
   */
  const scoped = (scope: ImportStatusScope) => ({
    error: status.scope === scope ? status.error : "",
    notice: status.scope === scope ? status.notice : ""
  });

  return {
    state,
    batch,
    visible: review.visible,
    filter: review.filter,
    setFilter: review.setFilter,
    blocking: review.blocking,
    ready: review.ready,
    pendingEdits: review.pendingEdits,
    applyDefaultsIn: review.applyDefaultsIn,
    removeBlockersIn: review.removeBlockersIn,
    calendarRecords: review.calendarRecords,
    selectedCalendarRecords: review.selectedCalendarRecords,
    setCalendarSelection: review.setCalendarSelection,
    recordActions: review.recordActions,
    aiKind: intake.aiKind,
    setAiKind: intake.setAiKind,
    aiText: intake.aiText,
    setAiText: intake.setAiText,
    aiImages: intake.aiImages,
    setAiImages: intake.setAiImages,
    referenceScopes: intake.referenceScopes,
    setReferenceScopes: intake.setReferenceScopes,
    diagnostics: intake.diagnostics,
    uploadKey: intake.uploadKey,
    success: status.success,
    busy: status.busy,
    error: status.error,
    notice: status.notice,
    captureStatus: scoped("capture"),
    intakeStatus: scoped("intake"),
    reviewStatus: scoped("review"),
    queueStatus: { ...scoped("queue"), success: status.success },
    queue: queue.queue,
    history: queue.history,
    queueLoaded: queue.queueLoaded,
    queueError: queue.queueError,
    refreshQueue: queue.refreshQueue,
    refreshOpenBatch,
    selectFiles: intake.selectFiles,
    extractAi: intake.extractAi,
    previewCalendarSource: intake.previewCalendarSource,
    openBatch: queue.openBatch,
    closeBatch: () => {
      review.closeBatch();
      status.setError("");
    },
    deleteBatch: queue.deleteBatch,
    saveDraft: commit.saveDraft,
    commit: commit.commit,
    commitReady: commit.commitReady,
    downloadErrors: () => batch && downloadImportErrors(batch),
    downloadReferenceFiles: intake.downloadReferenceFiles
  };
}

export type ImportWorkflow = ReturnType<typeof useImportWorkflow>;
