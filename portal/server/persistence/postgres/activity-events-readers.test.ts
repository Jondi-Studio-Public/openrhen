import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import map from "./activity-events-readers.json";

/**
 * The guard behind supersession: a reader of `activity_events` that forgets to decide what it does about a copy another copy
 * stands in for would show a message twice, or hide a row a delete must reach. So every non-test source file under
 * `portal/server` and `platform/database/src` that reads the table (`FROM` or `JOIN`) is listed in
 * `activity-events-readers.json` with its site count and its decision. A new file, a file that stopped reading the table,
 * or a changed count fails here, and the fix is to add the line with a reason.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const ROOTS = ["portal/server", "platform/database/src"];
const SITE = /\b(?:FROM|JOIN)\s+activity_events\b/gi;
const DECISIONS = ["hide", "keep", "none"];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

const found = new Map<string, { sites: number; text: string }>();
for (const root of ROOTS)
  for (const file of sourceFiles(join(repoRoot, root))) {
    const text = readFileSync(file, "utf8");
    const sites = text.match(SITE)?.length ?? 0;
    if (sites > 0) found.set(relative(repoRoot, file).split("\\").join("/"), { sites, text });
  }

describe("readers of activity_events", () => {
  it("lists every file that reads the table, and no other", () => {
    expect([...found.keys()].sort()).toEqual(Object.keys(map.readers).sort());
  });

  it("holds the site count of each file, so a new site in a listed file asks for a decision too", () => {
    expect(Object.fromEntries([...found].map(([file, item]) => [file, item.sites]))).toEqual(
      Object.fromEntries(Object.entries(map.readers).map(([file, item]) => [file, item.sites]))
    );
  });

  it("gives each file a decision from a closed list and a reason", () => {
    for (const [file, item] of Object.entries(map.readers)) {
      expect(DECISIONS, file).toContain(item.decision);
      expect(item.why.length, file).toBeGreaterThan(20);
    }
  });

  it("makes a file that decides to hide actually consult the links", () => {
    for (const [file, item] of Object.entries(map.readers))
      if (item.decision === "hide") expect(found.get(file)!.text, file).toContain("activity_supersessions");
  });
});
