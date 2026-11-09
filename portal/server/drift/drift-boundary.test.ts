import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The planner stays blind to drift: nothing under `engine/`, the planning contracts or the plan-input list imports
 * the drift module or reads what it produces, so a detection can never reorder what the plan offers.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const driftModule = join(repo, "platform", "contracts", "src", "drift");
const SKIPPED = new Set(["node_modules", "dist", "build", ".next", ".vinext", "coverage", ".git"]);

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : files(path);
    return /\.(?:ts|tsx|mjs|json)$/.test(entry.name) ? [path] : [];
  });
}

const READS_DRIFT =
  /drift[-/]|\/drift\b|contracts\/drift|detectDriftEpisodes|countDriftEpisodes|DriftEpisode|drift-report/;

function offenders(paths: string[]): string[] {
  return paths
    .filter((path) => !/\.test\.(?:ts|tsx|mjs)$/.test(path))
    .filter((path) => READS_DRIFT.test(readFileSync(path, "utf8")))
    .map((path) => relative(repo, path).split(sep).join("/"));
}

describe("drift boundary", () => {
  it("is not imported or read by anything under engine/", () => {
    expect(offenders(files(join(repo, "engine")))).toEqual([]);
  });

  it("is not read by the planning contracts, now-activity or the plan-input list", () => {
    const planning = files(join(repo, "platform", "contracts", "src", "planning"));
    const pinned = [join(repo, "platform", "contracts", "src", "data-flow", "plan-input-tables.json")];
    expect(offenders([...planning, ...pinned])).toEqual([]);
  });

  it("is not exported from the contracts barrel", () => {
    expect(readFileSync(join(repo, "platform", "contracts", "src", "index.ts"), "utf8")).not.toMatch(/drift/i);
  });

  it("imports nothing from the database, the portal or the planning contracts", () => {
    for (const path of files(driftModule).filter((file) => !file.endsWith(".test.ts"))) {
      const imports = [...readFileSync(path, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
      expect(
        imports.filter((specifier) => !specifier.startsWith("./")),
        path
      ).toEqual([]);
    }
  });
});
