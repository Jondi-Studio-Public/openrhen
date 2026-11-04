"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useImportWorkflow } from "./use-import-workflow";

type ImportWorkflow = ReturnType<typeof useImportWorkflow>;

const ImportWorkflowContext = createContext<ImportWorkflow | null>(null);

/**
 * One import workflow for the whole app shell. The `+` sheet's Paste or photo, Workbook and the calendar provider
 * tabs and the Inbox's queue both read it, so a batch made in the sheet is in the Inbox's queue at once
 * and what was typed or dropped in a tab survives switching to Capture and back. Mounted in the shell,
 * above the sheet and every page.
 */
export function ImportWorkflowProvider({ children }: { children: ReactNode }) {
  const workflow = useImportWorkflow();
  return <ImportWorkflowContext.Provider value={workflow}>{children}</ImportWorkflowContext.Provider>;
}

export function useImportWorkflowContext(): ImportWorkflow {
  const value = useContext(ImportWorkflowContext);
  if (!value) throw new Error("useImportWorkflowContext must be used inside the app shell.");
  return value;
}
