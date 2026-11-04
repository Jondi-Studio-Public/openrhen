"use client";

import { useState } from "react";

export interface ImportSuccess {
  count: number;
  message: string;
}

/**
 * Which part of the page an error or notice belongs to, so it can be shown beside the panel that
 * raised it rather than at the top of a page the reader has already scrolled past: `capture` for the
 * AI panel, `intake` for a workbook, CSV or calendar, `review` for saving and committing the batch
 * under review, `queue` for opening or deleting a queued batch.
 */
export type ImportStatusScope = "capture" | "intake" | "review" | "queue";

/**
 * The status lines every import action shares: one `busy` flag, one error, one notice, and the
 * success banner a commit leaves behind. `run` is the shape of every request the screen makes —
 * clear the lines, mark busy, do the work, keep the thrown message or a fallback, unmark — so the
 * intake, review and commit hooks describe only what their action does, never how it reports. Each
 * says where it is speaking from; a message set inside a `run` inherits that place.
 */
export function useImportStatus() {
  const [success, setSuccess] = useState<ImportSuccess | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ error: string; notice: string; scope: ImportStatusScope }>({
    error: "",
    notice: "",
    scope: "intake"
  });

  const setError = (error: string, scope?: ImportStatusScope) =>
    setMessage((current) => ({ ...current, error, scope: scope ?? current.scope }));
  const setNotice = (notice: string, scope?: ImportStatusScope) =>
    setMessage((current) => ({ ...current, notice, scope: scope ?? current.scope }));

  async function run(fallback: string, action: () => Promise<void>, scope: ImportStatusScope = "intake") {
    setBusy(true);
    setMessage({ error: "", notice: "", scope });
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback, scope);
    } finally {
      setBusy(false);
    }
  }

  return {
    success,
    setSuccess,
    busy,
    error: message.error,
    setError,
    notice: message.notice,
    setNotice,
    scope: message.scope,
    run
  };
}

export type ImportStatus = ReturnType<typeof useImportStatus>;
