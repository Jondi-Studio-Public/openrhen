import { dateTimeFormat, displayLocale } from "@/shared/locale";
import { sourceLabel, type ImportBatch } from "@openrhen/contracts";

/**
 * A batch as the Inbox queue lists it: enough to recognise it and judge whether it is worth
 * opening, without the records themselves. Records are fetched when the batch is opened, so a
 * queue of dozens of previews costs one small request rather than dozens of large ones.
 */
export interface ImportBatchSummary {
  id: string;
  sourceType: ImportBatch["sourceType"];
  inputKind: ImportBatch["inputKind"];
  status: ImportBatch["status"];
  version: number;
  createdAt: string;
  updatedAt: string;
  filename: string | null;
  /** Records that would be committed: not removed. */
  recordCount: number;
  /** Records that stop the batch committing: not removed and carrying validation errors. */
  blockingCount: number;
  /** When the batch was written. Null while it is still open, which is every batch in the queue. */
  committedAt: string | null;
}

const inputKindLabels: Record<ImportBatch["inputKind"], string> = {
  planning_data: "planning data",
  assignment: "assignment",
  brain_dump: "brain dump",
  task_list: "task list",
  project_plan: "project plan",
  capacity_commitments: "capacity and commitments",
  calendar_events: "new calendar events",
  calendar_updates: "calendar updates"
};

/** "Workbook · plan.xlsx", "AI · brain dump", "<provider> · new calendar events". */
export function describeImportBatchSource(
  summary: Pick<ImportBatchSummary, "sourceType" | "inputKind" | "filename">
): string {
  const kind = inputKindLabels[summary.inputKind];
  switch (summary.sourceType) {
    case "csv":
      return `CSV · ${summary.filename ?? kind}`;
    case "xlsx":
      return `Workbook · ${summary.filename ?? kind}`;
    case "ai_text":
    case "ai_image":
      return `AI · ${kind}`;
    case "google_calendar":
      return `Google Calendar · ${kind}`;
    case "fixture":
      return `Fixture · ${kind}`;
    default:
      return `${sourceLabel(summary.sourceType)} · ${kind}`;
  }
}

/** The one line the queue shows under a batch: what is in it and whether it can go. */
export function describeImportBatchState(
  summary: Pick<ImportBatchSummary, "status" | "recordCount" | "blockingCount">
) {
  const records = `${summary.recordCount} record${summary.recordCount === 1 ? "" : "s"}`;
  if (summary.status === "committed") return `${records} · committed`;
  if (summary.status === "failed") return `${records} · failed`;
  if (summary.blockingCount)
    return `${records} · ${summary.blockingCount} blocker${summary.blockingCount === 1 ? "" : "s"}`;
  return `${records} · ready to commit`;
}

/**
 * What to tell the user when an upload turned out to be a batch already in the queue: when it was
 * first previewed, in the batch's own timezone, so they can place it among the queue's other entries.
 */
export function describeReopenedBatch(batch: Pick<ImportBatch, "createdAt" | "timezone">): string {
  const when = batch.createdAt
    ? dateTimeFormat(displayLocale(), {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: batch.timezone
      }).format(new Date(batch.createdAt))
    : "an earlier visit";
  return `This file was already previewed on ${when}; reopened that batch instead of adding another.`;
}

/** Newest first, so the batch you just previewed is at the top and the forgotten ones sink. */
export function sortImportQueue(summaries: ImportBatchSummary[]): ImportBatchSummary[] {
  return [...summaries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * The queue after a batch has been previewed, saved or committed on this page: a committed batch
 * leaves it, any other batch is inserted or refreshed from the full batch the server returned.
 */
export function reconcileImportQueue(queue: ImportBatchSummary[], batch: ImportBatch): ImportBatchSummary[] {
  const rest = queue.filter((item) => item.id !== batch.id);
  if (batch.status === "committed" || batch.status === "failed") return rest;
  return sortImportQueue([...rest, summarizeImportBatch(batch)]);
}

/**
 * History after a batch has been committed here. A committed batch cannot be edited or deleted, so
 * the only movement is a new one arriving at the front; anything else the server sends is a refresh
 * of a row already there rather than a second copy of it.
 */
export function reconcileImportHistory(history: ImportBatchSummary[], batch: ImportBatch): ImportBatchSummary[] {
  if (batch.status !== "committed") return history;
  return [summarizeImportBatch(batch), ...history.filter((item) => item.id !== batch.id)];
}

/** The queue after a batch has been deleted: it is gone, and nothing takes its place. */
export function removeFromImportQueue(queue: ImportBatchSummary[], id: string): ImportBatchSummary[] {
  return queue.filter((item) => item.id !== id);
}

export function summarizeImportBatch(batch: ImportBatch): ImportBatchSummary {
  const active = batch.records.filter((record) => !record.removed);
  return {
    id: batch.id,
    sourceType: batch.sourceType,
    inputKind: batch.inputKind,
    status: batch.status,
    version: batch.version,
    createdAt: batch.createdAt ?? new Date(0).toISOString(),
    updatedAt: batch.createdAt ?? new Date(0).toISOString(),
    filename: batch.source.filename ?? null,
    recordCount: active.length,
    blockingCount: active.filter(
      (record) => record.errors.length || record.operation === "conflict" || record.operation === "rejected"
    ).length,
    // The batch itself carries no commit time; a batch summarised as committed was committed just
    // now, in this session, and a reload replaces this with what the server recorded.
    committedAt: batch.status === "committed" ? new Date().toISOString() : null
  };
}
