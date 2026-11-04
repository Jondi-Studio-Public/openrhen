"use client";

import { useState } from "react";
import { sourceLabel, type ImportBatch } from "@openrhen/contracts";
import {
  fileDataUrl,
  parseImportFiles,
  validateAiIntake,
  validateImportFileSelection
} from "@/features/imports/import-intake";
import {
  requestAiExtraction,
  requestImportPreview,
  requestCalendarSourcePreview,
  type AiImportKind
} from "@/features/imports/import-requests";
import { triggerDownload } from "@/features/imports/import-downloads";
import { describeReopenedBatch } from "@/features/imports/import-queue";
import { referenceScopeQuery } from "@/features/imports/reference-pack-scopes";
import type { ReferencePackMode, ReferencePackScope } from "@/features/imports/reference-pack-types";
import type { ImportStatus } from "./use-import-status";

/**
 * Bringing work in: a workbook or CSV selection, a text or image handed to AI extraction, a calendar provider
 * calendar preview, and the reference pack downloads. Each source ends in the same place — a batch
 * the server has persisted, handed to `receiveBatch` for review — and holds only its own inputs here.
 */
export function useImportIntake({
  timezone,
  status,
  receiveBatch,
  clearBatch
}: {
  timezone: string;
  status: ImportStatus;
  receiveBatch: (batch: ImportBatch) => void;
  clearBatch: () => void;
}) {
  const [aiKind, setAiKind] = useState<AiImportKind>("brain_dump");
  const [aiText, setAiText] = useState("");
  const [aiImages, setAiImages] = useState<File[]>([]);
  const [referenceScopes, setReferenceScopes] = useState<ReferencePackScope[]>([]);
  /** What the last file selection gave up — ignored columns and sheets — held here, not on the batch. */
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  /** Bumped after a commit so the file input remounts empty. */
  const [uploadKey, setUploadKey] = useState(0);

  /**
   * Each source resolves to the batch it handed to review, or null when it produced none (a refused
   * selection, a failure, a calendar provider with nothing new), so the caller can say where the work landed
   * without watching for a batch to appear.
   */
  async function selectFiles(files: FileList | null): Promise<ImportBatch | null> {
    let produced: ImportBatch | null = null;
    if (!files?.length) return null;
    status.setSuccess(null);
    setDiagnostics([]);
    const selected = [...files];
    const problem = validateImportFileSelection(selected);
    if (problem) {
      status.setError(problem, "intake");
      return null;
    }
    await status.run("Import preview failed.", async () => {
      const contents = await Promise.all(
        selected.map(async (file) => ({ name: file.name, bytes: await file.arrayBuffer() }))
      );
      const { diagnostics: findings, ...parsed } = await parseImportFiles(contents, timezone);
      setDiagnostics(findings);
      const { batch, reopened } = await requestImportPreview({ ...parsed, timezone });
      receiveBatch(batch);
      produced = batch;
      if (reopened) status.setNotice(describeReopenedBatch(batch));
    });
    return produced;
  }

  async function extractAi(): Promise<ImportBatch | null> {
    let produced: ImportBatch | null = null;
    status.setSuccess(null);
    setDiagnostics([]);
    const problem = validateAiIntake(aiText, aiImages);
    if (problem) {
      status.setError(problem, "capture");
      return null;
    }
    await status.run(
      "AI extraction failed.",
      async () => {
        const images = await Promise.all(
          aiImages.map(async (file) => ({ filename: file.name, mimeType: file.type, dataUrl: await fileDataUrl(file) }))
        );
        const batch = await requestAiExtraction({ inputKind: aiKind, timezone, text: aiText, images });
        receiveBatch(batch);
        produced = batch;
        status.setNotice("AI extraction is ready for review. Check every inferred or missing field before committing.");
      },
      "capture"
    );
    return produced;
  }

  async function previewCalendarSource(connectionId: string, mode: "new" | "updates"): Promise<ImportBatch | null> {
    let produced: ImportBatch | null = null;
    const label = sourceLabel(connectionId);
    status.setSuccess(null);
    setDiagnostics([]);
    await status.run(`${label} calendar preview failed.`, async () => {
      const result = await requestCalendarSourcePreview(connectionId, mode, timezone);
      if (!result.batch) {
        clearBatch();
        return status.setNotice(result.message ?? `No ${label} calendar events need review.`);
      }
      receiveBatch(result.batch);
      produced = result.batch;
      status.setNotice(
        mode === "new"
          ? `New ${label} calendar events are ready for review.`
          : `${label} calendar changes are ready for review.`
      );
    });
    return produced;
  }

  /**
   * One archive rather than two downloads: a pack is both files or neither — the guide is written for
   * the mode it was fetched with, and a workbook acted on without it is how an add-only sheet comes
   * back full of accidental updates — and two downloads from one click are not offered to the user
   * by the same rules.
   */
  function downloadReferenceFiles(mode: ReferencePackMode) {
    if (!referenceScopes.length) return;
    const query = `${referenceScopeQuery(referenceScopes)}${mode === "roundtrip" ? "&mode=roundtrip" : ""}`;
    triggerDownload(`/api/imports/reference-pack.zip?${query}`);
    status.setNotice(
      mode === "roundtrip"
        ? "Editing pack download started: workbook and tool guide, zipped together."
        : "Add-only pack download started: workbook and tool guide, zipped together."
    );
  }

  /** After a commit: the file input is remounted empty. */
  const resetUpload = () => setUploadKey((value) => value + 1);
  /** After a full commit: the AI text and images that produced the batch are cleared too. */
  const resetAi = () => {
    setAiText("");
    setAiImages([]);
  };

  return {
    aiKind,
    setAiKind,
    aiText,
    setAiText,
    aiImages,
    setAiImages,
    referenceScopes,
    setReferenceScopes,
    diagnostics,
    uploadKey,
    selectFiles,
    extractAi,
    previewCalendarSource,
    downloadReferenceFiles,
    resetUpload,
    resetAi
  };
}
