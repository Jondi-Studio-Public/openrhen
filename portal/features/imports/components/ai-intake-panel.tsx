"use client";

import type { AiImportKind } from "@/features/imports/import-requests";

/**
 * The kind of input is asked for first because it decides how the extraction reads the same words:
 * a brain dump becomes candidate work, while an assignment becomes one deliverable with a deadline.
 */
export function AiIntakePanel({
  kind,
  text,
  images,
  busy,
  onKindChange,
  onTextChange,
  onImagesChange,
  onExtract
}: {
  kind: AiImportKind;
  text: string;
  images: File[];
  busy: boolean;
  onKindChange: (kind: AiImportKind) => void;
  onTextChange: (text: string) => void;
  onImagesChange: (images: File[]) => void;
  onExtract: () => void;
}) {
  return (
    <div className="ai-intake">
      <h3>AI-assisted text and images</h3>
      <label className="field">
        <span>What kind of information is this?</span>
        <select value={kind} disabled={busy} onChange={(event) => onKindChange(event.target.value as AiImportKind)}>
          <option value="brain_dump">Brain dump</option>
          <option value="assignment">Assignment</option>
          <option value="task_list">Task list</option>
          <option value="project_plan">Project plan</option>
          <option value="capacity_commitments">Capacity and commitments</option>
        </select>
      </label>
      <label className="field">
        <span>Paste text</span>
        <textarea
          rows={8}
          maxLength={100000}
          value={text}
          disabled={busy}
          placeholder="Paste notes, requirements, tasks, dates, or a large unstructured dump…"
          onChange={(event) => onTextChange(event.target.value)}
        />
      </label>
      <label className="file-drop">
        <strong>Add supporting images</strong>
        <span>Up to five JPEG, PNG, or WebP images · 8 MB each · 20 MB total</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={busy}
          onChange={(event) => onImagesChange([...(event.target.files ?? [])])}
        />
      </label>
      {images.length ? <p className="microcopy">Selected: {images.map((file) => file.name).join(", ")}</p> : null}
      <button disabled={busy || (!text.trim() && !images.length)} onClick={onExtract}>
        Extract into review draft
      </button>
      <p className="microcopy">
        Unavailable information stays blank. Images are sent only for this extraction and are not retained.
      </p>
    </div>
  );
}
