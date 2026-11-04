"use client";

import Link from "next/link";
import { useState } from "react";
import type { ImportBatch } from "@openrhen/contracts";
import { AiIntakePanel } from "@/features/imports/components/ai-intake-panel";
import { ImportStatusBanners } from "@/features/imports/components/import-status-banners";
import { StructuredIntakePanel } from "@/features/imports/components/structured-intake-panel";
import { importPanelExtensions } from "@/features/imports/import-panel-extensions";
import { describeImportBatchSource, summarizeImportBatch } from "@/features/imports/import-queue";
import { useImportWorkflowContext } from "@/features/imports/import-workflow-provider";
import type { useImportWorkflow } from "@/features/imports/use-import-workflow";

/** The core tabs, and whatever a registered extension adds (`import-panel-extensions.ts`). */
export type ImportPanelId = "paste" | "workbook" | (string & Record<never, never>);

type Imports = ReturnType<typeof useImportWorkflow>;

/**
 * The import tabs of the `+` sheet: pasted text or a photo, a workbook or CSV, and any provider pull a registered extension adds. They
 * use the shell's one import workflow, which the Inbox's queue reads too, so a batch made here is
 * waiting under Calendar at once and what was typed survives a switch to another tab. Each ends as a
 * held batch under Calendar and says so. Nothing here writes to the plan.
 */
export function ImportPanels({ panel, onNavigate }: { panel: ImportPanelId; onNavigate: () => void }) {
  return <ImportPanelsView imports={useImportWorkflowContext()} panel={panel} onNavigate={onNavigate} />;
}

function ImportPanelsView({
  imports,
  panel,
  onNavigate
}: {
  imports: Imports;
  panel: ImportPanelId;
  onNavigate: () => void;
}) {
  const [landed, setLanded] = useState("");

  /** Runs an add that should end in a held batch, and says where that batch is waiting. */
  const addBatch = async (add: () => Promise<ImportBatch | null>) => {
    setLanded("");
    const batch = await add();
    if (!batch) return;
    const name = describeImportBatchSource(summarizeImportBatch(batch));
    setLanded(
      `${name} is held as an import batch under Calendar. It cannot change your plan until you review and commit it there.`
    );
  };

  return (
    <>
      {panel === "paste" && (
        <>
          <p className="reason">Text or photos are read into a batch you check before anything is written.</p>
          <AiIntakePanel
            kind={imports.aiKind}
            text={imports.aiText}
            images={imports.aiImages}
            busy={imports.busy}
            onKindChange={imports.setAiKind}
            onTextChange={imports.setAiText}
            onImagesChange={imports.setAiImages}
            onExtract={() => void addBatch(imports.extractAi)}
          />
          <ImportStatusBanners {...imports.captureStatus} />
        </>
      )}
      {panel === "workbook" && (
        <>
          <StructuredIntakePanel
            state={imports.state}
            busy={imports.busy}
            referenceScopes={imports.referenceScopes}
            onReferenceScopesChange={imports.setReferenceScopes}
            onDownloadReferenceFiles={imports.downloadReferenceFiles}
            onSelectFiles={(files) => void addBatch(() => imports.selectFiles(files))}
          />
          <ImportStatusBanners {...imports.intakeStatus} warnings={imports.diagnostics} />
        </>
      )}
      {importPanelExtensions().map(({ id, Panel }) =>
        panel === id ? <Panel key={id} imports={imports} addBatch={addBatch} /> : null
      )}
      {landed && (
        <p className="microcopy" role="status">
          {landed}{" "}
          <Link href="/inbox/calendar" onClick={onNavigate}>
            Open Calendar
          </Link>
        </p>
      )}
    </>
  );
}
