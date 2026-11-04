import type { ComponentType } from "react";
import type { ImportBatch } from "@openrhen/contracts";
import type { useImportWorkflow } from "./use-import-workflow";

/**
 * Registry of the import tabs a feature the OpenRhen export leaves out adds to the `+` sheet: a
 * provider's own pull, such as a shared-calendar read. `state/private/index.ts` registers each on import; the export
 * ships an empty one, so the sheet offers only Capture, Paste or photo, Workbook or CSV and Disruption.
 */
export interface ImportPanelProps {
  imports: ReturnType<typeof useImportWorkflow>;
  /** Runs an add that should end in a held batch, and says where that batch is waiting. */
  addBatch: (add: () => Promise<ImportBatch | null>) => Promise<void>;
}

export interface ImportPanelExtension {
  /** The sheet mode this tab opens (`CaptureSheetMode`). */
  id: string;
  label: string;
  Panel: ComponentType<ImportPanelProps>;
}

const panels: ImportPanelExtension[] = [];

export function registerImportPanel(panel: ImportPanelExtension): void {
  if (!panels.some((existing) => existing.id === panel.id)) panels.push(panel);
}

export function importPanelExtensions(): readonly ImportPanelExtension[] {
  return panels;
}
