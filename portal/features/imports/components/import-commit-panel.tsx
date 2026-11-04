"use client";

import type { ImportBatch } from "@openrhen/contracts";
import { Button } from "@/components/ui/button";

/**
 * Commit stays disabled until the server has said the batch is ready, so a draft that merely looks
 * clean in the browser cannot be committed on the strength of the browser's own opinion.
 *
 * When the saved batch has blockers, the whole-batch commit gives way to a partial one: commit the
 * records that are ready and move the blocked ones into a new batch to fix later. It too waits for
 * the server's word — the batch must be saved as `blocked`, not merely edited — and needs at least
 * one record ready to write.
 */
export function ImportCommitPanel({
  status,
  busy,
  blocking,
  ready,
  calendarCount,
  selectedCalendarCount,
  onSaveDraft,
  onCommit,
  onCommitReady,
  onDownloadErrors
}: {
  status: ImportBatch["status"];
  busy: boolean;
  blocking: number;
  ready: number;
  calendarCount: number;
  selectedCalendarCount: number;
  onSaveDraft: () => void;
  onCommit: () => void;
  onCommitReady: () => void;
  onDownloadErrors: () => void;
}) {
  const partial = blocking > 0;
  return (
    <section className="import-confirm">
      <h2>Validate and commit</h2>
      <div className="actions">
        <Button variant="primary" disabled={busy || status === "committed"} onClick={onSaveDraft}>
          Validate and save draft
        </Button>
        {partial ? (
          <Button variant="primary" wrap disabled={busy || status !== "blocked" || ready === 0} onClick={onCommitReady}>
            Commit {ready} ready · move {blocking} blocked to a new batch
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={busy || status !== "ready" || (calendarCount > 0 && !selectedCalendarCount)}
            onClick={onCommit}
          >
            {calendarCount
              ? `Import ${selectedCalendarCount} selected event${selectedCalendarCount === 1 ? "" : "s"}`
              : "Commit all"}
          </Button>
        )}
        {partial && (
          <Button variant="secondary" onClick={onDownloadErrors}>
            Download errors
          </Button>
        )}
      </div>
      <p className="microcopy">
        {partial
          ? status === "blocked"
            ? "Blocked records are moved, not committed: they wait in the queue as a new batch until they are fixed or removed."
            : "Validate and save the draft first; a partial commit works from the saved batch, not from unsaved edits."
          : "Only selected records are committed. Selected records with missing or invalid information must be corrected before import."}
      </p>
    </section>
  );
}
