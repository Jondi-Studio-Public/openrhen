import type { Shifter } from "./demo-dates.js";
import type { SavedCapture } from "./demo-data-inbox.js";

/**
 * Extra saved captures a private slice contributes to the demo seed (the mail slice's email changes). A slice
 * registers a source from `demo-seed/private/index.ts`; the export ships that index empty, so nothing registers.
 * A source gets the deliverable the captures attach to and returns nothing when it does not apply.
 */
export type DemoCaptureSource = (shifter: Shifter, networkReportId: string) => SavedCapture[];

const sources: DemoCaptureSource[] = [];

export function registerDemoCaptures(source: DemoCaptureSource): void {
  sources.push(source);
}

export function extraCaptures(shifter: Shifter, networkReportId: string): SavedCapture[] {
  return sources.flatMap((source) => source(shifter, networkReportId));
}
