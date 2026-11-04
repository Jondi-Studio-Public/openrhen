"use client";

import { Button } from "@/components/ui/button";
import { ImportCommitPanel } from "@/features/imports/components/import-commit-panel";
import { ImportReviewPanel } from "@/features/imports/components/import-review-panel";
import { ImportStatusBanners } from "@/features/imports/components/import-status-banners";
import { describeImportBatchSource, summarizeImportBatch } from "@/features/imports/import-queue";
import { useInbox } from "../inbox-provider";
import styles from "./batch-review.module.css";

/**
 * The batch under review, with its commit controls: the Inbox's detail for a calendar's held events
 * or a held import, opened from its summary by Change first. `onClose` goes back to that summary.
 */
export function BatchReview({
  onClose,
  closeLabel = "Close review"
}: { onClose?: () => void; closeLabel?: string } = {}) {
  const { imports } = useInbox();
  const batch = imports.batch;

  if (!batch) return null;
  return (
    <div className={styles.root}>
      <div className="inbox-batch-heading">
        <p className="eyebrow">{describeImportBatchSource(summarizeImportBatch(batch))}</p>
        <Button type="button" variant="secondary" size="sm" onClick={onClose ?? imports.closeBatch}>
          {closeLabel}
        </Button>
      </div>
      <ImportReviewPanel
        records={batch.records}
        visibleRecords={imports.visible}
        sourceType={batch.sourceType}
        filter={imports.filter}
        blocking={imports.blocking}
        ready={imports.ready}
        pendingEdits={imports.pendingEdits}
        calendarCount={imports.calendarRecords.length}
        selectedCalendarCount={imports.selectedCalendarRecords.length}
        onFilterChange={imports.setFilter}
        onCalendarSelection={imports.setCalendarSelection}
        onApplyDefaults={imports.applyDefaultsIn}
        onRemoveBlockers={imports.removeBlockersIn}
        recordActions={imports.recordActions}
        banners={<ImportStatusBanners {...imports.reviewStatus} />}
      />
      <ImportCommitPanel
        status={batch.status}
        busy={imports.busy}
        blocking={imports.blocking}
        ready={imports.ready}
        calendarCount={imports.calendarRecords.length}
        selectedCalendarCount={imports.selectedCalendarRecords.length}
        onSaveDraft={() => void imports.saveDraft()}
        onCommit={() => void imports.commit()}
        onCommitReady={() => void imports.commitReady()}
        onDownloadErrors={imports.downloadErrors}
      />
    </div>
  );
}
