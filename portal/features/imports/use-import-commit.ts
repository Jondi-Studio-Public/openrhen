"use client";

import type { ImportBatch } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import { commitImportBatch, commitReadyImportBatch, saveImportDraft } from "@/features/imports/import-requests";
import type { ImportStatus } from "./use-import-status";

/** Kept records a commit writes: everything not removed and not a delete. */
const writtenCount = (batch: ImportBatch) =>
  batch.records.filter((record) => !record.removed && record.operation !== "delete").length;

const RECALCULATED = "Forecasts and your current recommendation are being recalculated.";

/**
 * Moving the batch under review forward: save it as a draft (which revalidates it), commit it whole,
 * or commit what is ready and leave the rest in a new batch. A commit closes the review, updates the
 * queue with what the server says happened to each batch, and hands the new planning state on.
 */
export function useImportCommit({
  batch,
  status,
  acceptServerState,
  receiveBatch,
  reconcileQueue,
  afterCommit
}: {
  batch: ImportBatch | null;
  status: ImportStatus;
  acceptServerState: (state: PortalState) => void;
  receiveBatch: (batch: ImportBatch) => void;
  reconcileQueue: (batch: ImportBatch) => void;
  /** Closes the review and clears whatever intake produced the batch; `full` says the whole batch went. */
  afterCommit: (full: boolean) => void;
}) {
  async function saveDraft() {
    if (!batch) return;
    await status.run(
      "Draft save failed.",
      async () => {
        receiveBatch(await saveImportDraft(batch));
        status.setNotice("Draft validated and saved.");
      },
      "review"
    );
  }

  async function commit() {
    if (!batch) return;
    await status.run(
      "Commit failed.",
      async () => {
        const committedCount = writtenCount(batch);
        const result = await commitImportBatch(batch);
        acceptServerState(result.state);
        reconcileQueue(result.batch);
        afterCommit(true);
        status.setSuccess({ count: committedCount, message: `The import completed successfully. ${RECALCULATED}` });
      },
      "review"
    );
  }

  /**
   * Commits what is ready and leaves the blockers in a new batch. The committed batch leaves the
   * queue and the deferred one joins it; the review closes, since what was under review is now split
   * between history and a batch the queue can reopen.
   */
  async function commitReady() {
    if (!batch) return;
    await status.run(
      "Commit failed.",
      async () => {
        const result = await commitReadyImportBatch(batch);
        acceptServerState(result.state);
        reconcileQueue(result.batch);
        if (result.deferred) reconcileQueue(result.deferred);
        afterCommit(false);
        const moved = result.deferred?.records.filter((record) => !record.removed).length ?? 0;
        status.setSuccess({
          count: writtenCount(result.batch),
          message: moved
            ? `${moved} blocked record${moved === 1 ? " was" : "s were"} moved to a new batch in the queue to fix later. ${RECALCULATED}`
            : `The import completed successfully. ${RECALCULATED}`
        });
      },
      "review"
    );
  }

  return { saveDraft, commit, commitReady };
}
