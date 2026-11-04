import type { ImportRecord } from "@openrhen/contracts";
import type { PortalState } from "@/state/portal-state";

export interface ImportExtractionInput {
  inputKind: "assignment" | "brain_dump" | "task_list" | "project_plan" | "capacity_commitments";
  timezone: string;
  text?: string;
  images?: Array<{ filename: string; mimeType: "image/jpeg" | "image/png" | "image/webp"; bytes: Uint8Array }>;
  currentState: Pick<PortalState, "areas" | "outcomes" | "projects" | "actions">;
}

export interface ImportExtractor {
  extract(input: ImportExtractionInput): Promise<ImportRecord[]>;
}

export class FixtureImportExtractor implements ImportExtractor {
  constructor(private readonly records: ImportRecord[]) {}
  async extract(_input: ImportExtractionInput): Promise<ImportRecord[]> {
    return structuredClone(this.records);
  }
}
