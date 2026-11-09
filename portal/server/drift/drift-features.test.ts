import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/** The rules and the evaluation take no pulse-state internals as features: an import-graph test, not a grep of one file. */
const here = dirname(fileURLToPath(import.meta.url));
const driftDir = join(resolve(here, "..", "..", ".."), "platform", "contracts", "src", "drift");
describe("drift rule features", () => {
  const FORBIDDEN_NAMES = /\b(unknownMinutes|since|promptedAt|promptAt|promptTiming|sessionStale|jitter)\b/;

  function closure(entry: string, seen = new Set<string>()): Set<string> {
    if (seen.has(entry)) return seen;
    seen.add(entry);
    const source = readFileSync(entry, "utf8");
    for (const match of source.matchAll(/(?:from|import)\s+"([^"]+)"/g)) {
      const specifier = match[1] ?? "";
      if (specifier.startsWith(".")) closure(resolve(dirname(entry), specifier.replace(/\.js$/, ".ts")), seen);
      else seen.add(`external:${specifier}`);
    }
    return seen;
  }

  for (const file of ["drift-rules.ts", "drift-eval.ts"]) {
    it(`${file} reaches no pulse module and no pulse-state internals`, () => {
      const modules = [...closure(join(driftDir, file))];
      expect(modules.filter((m) => m.startsWith("external:"))).toEqual([]);
      expect(modules.filter((m) => /pulse/i.test(m))).toEqual([]);
      for (const module of modules) {
        expect(readFileSync(module, "utf8").match(FORBIDDEN_NAMES)?.[0], module).toBeUndefined();
      }
    });
  }
});
