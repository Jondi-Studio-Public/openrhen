import type { Fields } from "./demo-data-planning.js";

/**
 * Previewed (uncommitted) calendar import batches a private slice contributes to the demo seed. A slice registers one
 * from `demo-seed/private/index.ts`; the export ships that index empty, so nothing registers and the seed skips the
 * section.
 */
export type DemoCalendarImport = () => Fields;

const imports: DemoCalendarImport[] = [];

export function registerDemoCalendarImport(build: DemoCalendarImport): void {
  imports.push(build);
}

export function demoCalendarImports(): Fields[] {
  return imports.map((build) => build());
}
