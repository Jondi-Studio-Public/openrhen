import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Watch history stays invisible to the planning engine: its tables are not plan inputs (so a write queues no
 * recalculation) and nothing that builds the portal state or the forecast request reads them.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const WATCH_TABLES = ["watch_events", "watch_imports", "video_info"];

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [{ path, text: readFileSync(path, "utf8") }];
  });
}

describe("watch history is blind to the engine", () => {
  it("is absent from PLAN_INPUT_TABLES", () => {
    const registry = readFileSync(join(repo, "scripts", "repository", "write-path-registry.mjs"), "utf8");
    const list = /export const PLAN_INPUT_TABLES = \[([\s\S]*?)\]/.exec(registry)?.[1];
    expect(list).toBeTruthy();
    for (const table of WATCH_TABLES) expect(list).not.toContain(`"${table}"`);
    // The list is really the one that guards plan inputs: it still names a table the engine reads.
    expect(list).toContain('"actions"');
  });

  it("is never read by readPortalState or buildPlanForecastRequest", () => {
    const files = [
      {
        path: "state-read.ts",
        text: readFileSync(join(repo, "portal", "server", "persistence", "postgres", "state-read.ts"), "utf8")
      },
      ...sources(join(repo, "portal", "server", "persistence", "postgres", "readers")),
      ...sources(join(repo, "platform", "database", "src", "planning"))
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files)
      for (const table of WATCH_TABLES) expect(file.text, `${file.path} names ${table}`).not.toContain(table);
  });
});
