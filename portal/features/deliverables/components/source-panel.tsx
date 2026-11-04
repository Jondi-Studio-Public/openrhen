"use client";

import { useState } from "react";
import type { StoredDeliverable } from "@/state/portal-state";
import { formatBytes } from "@/features/deliverables/deliverable-model";

const fileDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });

export interface SourceAttachment {
  sourceTitle: string;
  text?: string | undefined;
  files: { filename: string; mimeType: string; dataUrl: string }[];
}

/**
 * Retained source files, and — inside a session — the composer that adds one to the workspace.
 *
 * Attaching a source no longer runs a bulk extraction that answered with dozens of candidate
 * requirement cards. It retains the file and hands it to the assistant, which reads it on every
 * turn: the person then talks the requirements out of it a few at a time and only the ones they
 * agree to reach the contract.
 */
export function SourcePanel({
  deliverable,
  editable,
  disabled,
  onAttach
}: {
  deliverable: StoredDeliverable;
  editable: boolean;
  /** True while a draft is unsaved or a request is in flight; attaching would race the save. */
  disabled: boolean;
  onAttach: (request: SourceAttachment) => Promise<void>;
}) {
  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceFiles, setSourceFiles] = useState<File[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [error, setError] = useState("");
  const ready = Boolean(sourceTitle.trim() && (sourceText.trim() || sourceFiles.length));

  async function attach() {
    if (!ready) return;
    setAttaching(true);
    setError("");
    try {
      const files = await Promise.all(
        sourceFiles.map(async (file) => ({
          filename: file.name,
          mimeType: file.type,
          dataUrl: await fileDataUrl(file)
        }))
      );
      await onAttach({ sourceTitle: sourceTitle.trim(), text: sourceText.trim() || undefined, files });
      setSourceTitle("");
      setSourceText("");
      setSourceFiles([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The source could not be attached.");
    } finally {
      setAttaching(false);
    }
  }

  return (
    <section aria-label="Sources">
      <div className="section-heading">
        <h2>Retained source files</h2>
        <span>{deliverable.sourceFiles.length}</span>
      </div>
      {deliverable.sourceFiles.map((file) => (
        <a
          className="source-link"
          href={`/api/deliverable-source-files/${encodeURIComponent(file.id)}`}
          target="_blank"
          rel="noreferrer"
          key={file.id}
        >
          <span>{file.filename}</span>
          <small>{formatBytes(file.byteSize)}</small>
        </a>
      ))}
      {!deliverable.sourceFiles.length && <p className="empty">No retained files yet.</p>}
      {editable && (
        <div className="source-composer">
          <p className="microcopy">
            Anything you attach here is read by the assistant on every turn. Add a brief, then ask it to work through
            the requirements with you.
          </p>
          <input
            aria-label="Source name"
            value={sourceTitle}
            maxLength={255}
            placeholder="Source name, e.g. Assessment brief"
            disabled={attaching}
            onChange={(event) => setSourceTitle(event.target.value)}
          />
          <textarea
            aria-label="Paste source text"
            rows={3}
            maxLength={100000}
            value={sourceText}
            placeholder="Paste instructions or notes here…"
            disabled={attaching}
            onChange={(event) => setSourceText(event.target.value)}
          />
          <label className="file-picker">
            Add photos, PDF or DOCX
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx"
              multiple
              disabled={attaching}
              onChange={(event) => setSourceFiles([...(event.target.files ?? [])])}
            />
          </label>
          {sourceFiles.length ? (
            <small>{sourceFiles.map((file) => `${file.name} (${formatBytes(file.size)})`).join(", ")}</small>
          ) : null}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="button" disabled={disabled || attaching || !ready} onClick={() => void attach()}>
            {attaching ? "Attaching…" : "Add source to the conversation"}
          </button>
        </div>
      )}
    </section>
  );
}
