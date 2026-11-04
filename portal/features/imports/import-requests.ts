import { sourceLabel, type ImportBatch, type ImportRecord } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";
import type { ImportBatchSummary } from "@/features/imports/import-queue";

/**
 * Every import route answers with the same envelope: a batch, or an `error` the user should read.
 * These wrappers turn that envelope into a value or a thrown message so the page only decides what
 * to show, never how the response is shaped.
 */
export type AiImportKind = "assignment" | "brain_dump" | "task_list" | "project_plan" | "capacity_commitments";

/**
 * The response body as JSON, or an empty envelope when it is not (a proxy's plain-text 502, a crash
 * page), so the caller's own sentence is shown rather than the parser's "Unexpected token".
 */
async function envelope(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

/**
 * `reopened` is true when the server recognised the content as a batch already waiting in the queue
 * and handed that one back instead of creating another; the caller says so rather than announcing a
 * new preview.
 */
export async function requestImportPreview(input: {
  sourceType: "csv" | "xlsx";
  timezone: string;
  records: ImportRecord[];
  source: { filename: string; mimeType: string; contentHash: string };
}): Promise<{ batch: ImportBatch; reopened: boolean }> {
  const response = await fetch(
    "/api/imports/preview",
    json({ ...input, inputKind: "planning_data", templateVersion: "1" })
  );
  const result = (await envelope(response)) as { batch?: ImportBatch; reopened?: boolean; error?: string };
  if (!response.ok || !result.batch) throw new Error(result.error ?? "Preview failed.");
  return { batch: result.batch, reopened: result.reopened === true };
}

export async function requestAiExtraction(input: {
  inputKind: AiImportKind;
  timezone: string;
  text: string;
  images: Array<{ filename: string; mimeType: string; dataUrl: string }>;
}): Promise<ImportBatch> {
  const response = await fetch("/api/imports/extract", json(input));
  const result = (await envelope(response)) as { batch?: ImportBatch; error?: string };
  if (!response.ok || !result.batch) throw new Error(result.error ?? "AI extraction failed.");
  return result.batch;
}

/** A calendar provider preview legitimately has nothing to review, which is a message rather than a batch. */
export async function requestCalendarSourcePreview(
  connectionId: string,
  mode: "new" | "updates",
  timezone: string
): Promise<{ batch: ImportBatch | null; message?: string }> {
  const response = await fetch(`/api/connections/${connectionId}/import/preview`, json({ mode, timezone }));
  const result = (await envelope(response)) as { batch?: ImportBatch | null; message?: string; error?: string };
  if (!response.ok) throw new Error(result.error ?? `${sourceLabel(connectionId)} calendar preview failed.`);
  return { batch: result.batch ?? null, ...(result.message === undefined ? {} : { message: result.message }) };
}

/** The Inbox queue: previewed, not yet committed, newest first, without records. */
export async function requestOpenImportBatches(): Promise<{
  batches: ImportBatchSummary[];
  history: ImportBatchSummary[];
}> {
  const response = await fetch("/api/imports");
  const result = (await envelope(response)) as {
    batches?: ImportBatchSummary[];
    history?: ImportBatchSummary[];
    error?: string;
  };
  if (!response.ok || !result.batches) throw new Error(result.error ?? "The import queue could not be loaded.");
  return { batches: result.batches, history: result.history ?? [] };
}

/** One queued batch in full, when it is opened for review. */
export async function requestImportBatch(id: string): Promise<ImportBatch> {
  const response = await fetch(`/api/imports/${id}`);
  const result = (await envelope(response)) as { batch?: ImportBatch; error?: string };
  if (!response.ok || !result.batch) throw new Error(result.error ?? "Import batch not found.");
  return result.batch;
}

/** Removes a queued batch and its records for good. The server refuses a committed batch. */
export async function deleteImportBatch(id: string): Promise<void> {
  const response = await fetch(`/api/imports/${id}`, { method: "DELETE" });
  const result = (await envelope(response)) as { deleted?: boolean; error?: string };
  if (!response.ok || !result.deleted) throw new Error(result.error ?? "The import batch could not be deleted.");
}

export async function saveImportDraft(batch: ImportBatch): Promise<ImportBatch> {
  const response = await fetch(`/api/imports/${batch.id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: batch.version, records: batch.records })
  });
  const result = (await envelope(response)) as { batch?: ImportBatch; error?: string };
  if (!response.ok || !result.batch) throw new Error(result.error ?? "Draft save failed.");
  return result.batch;
}

export async function commitImportBatch(batch: ImportBatch): Promise<{ batch: ImportBatch; state: PortalState }> {
  const response = await fetch(`/api/imports/${batch.id}/commit`, json({ expectedVersion: batch.version }));
  const result = (await envelope(response)) as { batch?: ImportBatch; state?: PortalState; error?: string };
  if (!response.ok || !result.batch || !result.state) throw new Error(result.error ?? "Commit failed.");
  return { batch: result.batch, state: result.state };
}

/**
 * A partial commit: the batch's ready records are written and its blockers move into a new draft
 * batch, which comes back as `deferred` (null when nothing was blocked). Both batches and the state
 * are required, as for a full commit.
 */
export async function commitReadyImportBatch(
  batch: ImportBatch
): Promise<{ batch: ImportBatch; deferred: ImportBatch | null; state: PortalState }> {
  const response = await fetch(`/api/imports/${batch.id}/commit-ready`, json({ expectedVersion: batch.version }));
  const result = (await envelope(response)) as {
    batch?: ImportBatch;
    deferred?: ImportBatch | null;
    state?: PortalState;
    error?: string;
  };
  if (!response.ok || !result.batch || !result.state) throw new Error(result.error ?? "Commit failed.");
  return { batch: result.batch, deferred: result.deferred ?? null, state: result.state };
}
