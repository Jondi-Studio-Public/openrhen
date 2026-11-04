"use client";

import { importCsvEntities } from "@/features/imports/import-spec";
import type { ReferencePackMode, ReferencePackScope } from "@/features/imports/reference-pack-types";
import { ReferenceScopeBrowser } from "./reference-scope-browser";
import type { PortalState } from "@/state/portal-state";

/**
 * The panel is ordered by what is done most often, which is uploading a file that is already filled
 * in — so that is all the open panel offers. Every way of fetching a file to fill in is folded away
 * until it is what is happening: the per-entity CSVs, for one kind of record or for someone without
 * Excel, and the reference packs, for handing an existing plan to an external tool.
 *
 * There are two packs and no loose files. The add-only pack exists so an external tool can add to a
 * plan without inventing keys that collide with what is already there: current data comes back as
 * ignored Reference sheets, and only the empty import sheets are read back in. The editing pack is
 * the same workbook with those sheets already filled in, for correcting records in bulk. Each is
 * downloaded as a workbook and the guide written for that mode, because a guide that describes the
 * other pack's rules is worse than none — it tells the tool to do the opposite of what is wanted.
 */
export function StructuredIntakePanel({
  state,
  busy,
  referenceScopes,
  onReferenceScopesChange,
  onDownloadReferenceFiles,
  onSelectFiles
}: {
  state: PortalState;
  busy: boolean;
  referenceScopes: ReferencePackScope[];
  onReferenceScopesChange: (scopes: ReferencePackScope[]) => void;
  onDownloadReferenceFiles: (mode: ReferencePackMode) => void;
  onSelectFiles: (files: FileList | null) => void;
}) {
  return (
    <div className="bulk-intake">
      <h3>Structured workbook or CSV</h3>
      <label className="file-drop">
        <strong>Select a completed workbook or CSV templates</strong>
        <span>One XLSX or multiple CSV files · 2,000 records · 5 MB total</span>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
          multiple
          disabled={busy}
          onChange={(event) => onSelectFiles(event.target.files)}
        />
      </label>
      <p className="microcopy">Nothing is written until you review the preview and commit it.</p>
      <details className="csv-fold">
        <summary>Prefer CSV, or only filling in one kind of record?</summary>
        <div className="template-links">
          <a className="button-link" href="/api/imports/templates.zip">
            All CSV templates
          </a>
          <a className="quiet button-link" href="/import-template-guide.md">
            Field guide
          </a>
        </div>
        <div className="template-links">
          {importCsvEntities.map((entity) => (
            <a className="quiet button-link" href={`/api/imports/templates/${entity}`} key={entity}>
              {entity.replaceAll("_", " ")}.csv
            </a>
          ))}
        </div>
        <p className="microcopy">
          One header row per file, carrying that entity&rsquo;s full column set; the archive holds all of them at once,
          and the field guide explains every column. Select several at a time and they preview as one batch.
        </p>
      </details>
      <details className="reference-fold">
        <summary>Working with an external tool, or editing existing records in bulk?</summary>
        <div className="reference-export">
          <div>
            <h4>Take the plan out, and bring it back</h4>
            <p className="microcopy">
              Each pack downloads as one zip holding a workbook and the companion guide written for it. The guide tells
              an external tool the exact fields, relationships, validation rules, and create/update behaviour for that
              pack, so the two must stay paired &mdash; unzip it and hand the tool both.
            </p>
          </div>
          <ReferenceScopeBrowser state={state} selected={referenceScopes} onChange={onReferenceScopesChange} />
          <div className="actions">
            <button type="button" disabled={!referenceScopes.length} onClick={() => onDownloadReferenceFiles("add")}>
              Download add-only pack
            </button>
            <button
              type="button"
              disabled={!referenceScopes.length}
              onClick={() => onDownloadReferenceFiles("roundtrip")}
            >
              Download editing pack
            </button>
          </div>
          <p className="microcopy">
            The <strong>add-only pack</strong> carries your current data as ignored Reference sheets beside empty import
            sheets, so a tool can add work without reusing a key that already exists. Every intended addition should
            preview as Create; an unexpected Update means the new row reused an existing import key.
          </p>
          <p className="microcopy">
            The <strong>editing pack</strong> is the same workbook pre-filled with your current records, for correcting
            many of them at once: change what is wrong, delete the columns you do not mean to touch, and upload it back.
            Every row should preview as Update; an unexpected Create means a key was altered.
          </p>
        </div>
      </details>
    </div>
  );
}
