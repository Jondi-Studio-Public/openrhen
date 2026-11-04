"use client";

import { useCallback, useEffect, useState } from "react";
import type { ImportBatch } from "@openrhen/contracts";
import { deleteImportBatch, requestImportBatch, requestOpenImportBatches } from "@/features/imports/import-requests";
import {
  reconcileImportHistory,
  reconcileImportQueue,
  removeFromImportQueue,
  sortImportQueue,
  type ImportBatchSummary
} from "@/features/imports/import-queue";
import type { ImportStatus } from "./use-import-status";

/**
 * The queue of open batches. Every preview the server answers with is a persisted batch, so anything
 * previewed and then abandoned is still waiting; the queue lists those, and each preview, save or
 * commit made elsewhere reconciles the list through `reconcile` rather than refetching it.
 */
export function useImportQueue({
  status,
  currentBatchId,
  receiveBatch,
  closeBatch
}: {
  status: ImportStatus;
  currentBatchId: string | null;
  receiveBatch: (batch: ImportBatch) => void;
  closeBatch: () => void;
}) {
  const [queue, setQueue] = useState<ImportBatchSummary[]>([]);
  /** What has been written, newest first. A committed batch cannot return to the queue. */
  const [history, setHistory] = useState<ImportBatchSummary[]>([]);
  const [queueLoaded, setQueueLoaded] = useState(false);
  const [queueError, setQueueError] = useState("");

  const refreshQueue = useCallback(async () => {
    try {
      const { batches, history: written } = await requestOpenImportBatches();
      setQueue(sortImportQueue(batches));
      setHistory(written);
      setQueueError("");
    } catch (cause) {
      setQueueError(cause instanceof Error ? cause.message : "The import queue could not be loaded.");
    } finally {
      setQueueLoaded(true);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- sets state only after the awaited request settles
    void refreshQueue();
  }, [refreshQueue]);

  /** One batch moves both lists at once: a commit takes it out of the queue and into history. */
  const reconcile = (batch: ImportBatch) => {
    setQueue((current) => reconcileImportQueue(current, batch));
    setHistory((current) => reconcileImportHistory(current, batch));
  };

  /** Reopens a queued batch: the server copy is authoritative, so any unsaved edits here are dropped. */
  async function openBatch(id: string) {
    status.setSuccess(null);
    await status.run(
      "Import batch could not be opened.",
      async () => {
        receiveBatch(await requestImportBatch(id));
      },
      "queue"
    );
  }

  /**
   * Drops a queued batch for good. The row leaves the list only once the server has confirmed the
   * delete: an optimistic removal that then failed would leave the user believing a batch is gone
   * while it is still waiting on the next load.
   */
  async function deleteBatch(id: string) {
    status.setSuccess(null);
    await status.run(
      "The import batch could not be deleted.",
      async () => {
        await deleteImportBatch(id);
        setQueue((current) => removeFromImportQueue(current, id));
        if (currentBatchId === id) closeBatch();
        status.setNotice("Import batch deleted.");
      },
      "queue"
    );
  }

  return { queue, history, queueLoaded, queueError, refreshQueue, reconcile, openBatch, deleteBatch };
}
