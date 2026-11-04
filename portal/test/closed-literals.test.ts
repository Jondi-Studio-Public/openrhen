import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const portal = resolve(__dirname, "..");
const roots = ["app", "components", "features", "shared", "state"];

/** A comparison of a status to the literal "cancelled" or "archived" (or a steps list of them). */
const LITERAL = /[sS]tatus\)? *(?:===|!==|==|!=) *"(?:cancelled|archived)"|\["done", "cancelled"\]/g;

/**
 * Where a literal is right: it means one specific status, not "closed". A place that means closed uses
 * `isClosedStatus` (platform/contracts), so a legacy cancelled area or a newly cancelled action is treated the same
 * as an archived one. Each entry says why, and the test fails when an entry stops matching, so the list cannot rot.
 */
const ALLOWED: Record<string, string> = {
  "app/setup/page.tsx": "context definitions: archived is their only closed status",
  "components/situation-panel.tsx": "context definitions: archived is their only closed status",
  "features/closed/components/close-control.tsx": "picks the restore verb from the status it is restoring",
  "features/deliverables/components/requirement-pathways.tsx":
    "context definitions: archived is their only closed status",
  "features/deliverables/components/step-rail.tsx": "deliverable steps",
  "features/deliverables/deliverable-model.ts": "deliverable steps",
  "features/now/components/availability-panel.tsx": "context definitions: archived is their only closed status",
  "features/now/components/travel-panel.tsx": "context definitions: archived is their only closed status",
  "features/now/components/wake-routine-panel.tsx": "routine steps",
  "features/now/now-model.ts": "an occurrence check (occurrences are not closable records)",
  "features/plan-map/map-view-model.ts": "map nodes: a legacy cancelled area is folded by partitionArchivedAreas",
  "features/plan-map/plan-map-model.ts": "map nodes: archived subjects",
  "features/plan/components/action-context-fields.tsx": "context definitions: archived is their only closed status",
  "features/plan/components/area-overview.tsx": "the 'Archived' label on an area",
  "features/routines/components/routine-toolbar.tsx": "routine presets: archived is their only closed status",
  "features/routines/routine-editor.ts": "routine presets: archived is their only closed status",
  "features/settings/components/context-definition-editor.tsx":
    "context definitions, and the commitments list in a picker",
  "features/settings/components/typed-context-manager.tsx": "context definitions: archived is their only closed status",
  "features/settings/location-coordinates.ts": "context definitions: archived is their only closed status",
  "features/today/commitment-save.ts": "re-adding a contact reopens an archived one, on purpose",
  "features/today/day-plan.ts": "steps, sleep plans and occurrences",
  "features/today/tomorrow-preview.ts": "occurrences, steps and sleep plans",
  "state/portal-state.ts": "anchored steps"
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "api" && dir === join(portal, "app") ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("closed status literals", () => {
  it("compares a status to cancelled or archived only where that one status is meant", () => {
    const found = new Set<string>();
    for (const root of roots) {
      for (const file of sourceFiles(join(portal, root))) {
        if (LITERAL.test(readFileSync(file, "utf8"))) found.add(relative(portal, file).replaceAll("\\", "/"));
        LITERAL.lastIndex = 0;
      }
    }
    const unexplained = [...found].filter((file) => !(file in ALLOWED)).sort();
    const stale = Object.keys(ALLOWED)
      .filter((file) => !found.has(file))
      .sort();
    expect({ unexplained, stale }).toEqual({ unexplained: [], stale: [] });
  });
});
