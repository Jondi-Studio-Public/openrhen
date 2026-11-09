import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Reads replay case files from a directory outside git, for `parseExternalCases`
 * (platform/contracts/src/planning/replay/replay-external.ts). A missing or unset directory gives no
 * files, so the optional set is skipped cleanly; one inside a git checkout is refused, so private
 * cases cannot be committed by accident.
 */
export function readCaseFiles(directory) {
  if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) return [];
  for (let dir = resolve(directory); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) throw new Error("external replay cases must live outside any git checkout");
    if (dirname(dir) === dir) break;
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(directory, name), "utf8") }));
}
