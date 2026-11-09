import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Reads replay case files from a directory outside git, for `parseExternalCases`
 * (platform/contracts/src/planning/replay/replay-external.ts). A missing or unset directory gives no
 * files, so the optional set is skipped cleanly; one inside a git checkout is refused, so private
 * cases cannot be committed by accident.
 *
 * Every check is made on real paths: a symlinked directory, or a symlinked file, that points into a
 * checkout is a checkout, whatever the link itself sits next to.
 */
function assertOutsideCheckout(path, what) {
  for (let dir = path; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git")))
      throw new Error(`external replay cases must live outside any git checkout (${what})`);
    if (dirname(dir) === dir) return;
  }
}

export function readCaseFiles(directory) {
  if (!directory || !existsSync(directory) || !statSync(directory).isDirectory()) return [];
  const real = realpathSync(resolve(directory));
  assertOutsideCheckout(real, "directory");
  return readdirSync(real)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const file = realpathSync(join(real, name));
      assertOutsideCheckout(dirname(file), `file ${name}`);
      return { name, text: readFileSync(file, "utf8") };
    });
}
