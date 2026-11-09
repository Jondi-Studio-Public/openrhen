import { readFileSync, readdirSync } from "node:fs";
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

  // Reasons and tags are the owner's words, known only after the drift: a rule that took them as a feature would learn its own label's cause.
  for (const file of ["drift-rules.ts", "drift-eval.ts", "drift-episodes.ts", "drift-labels.ts"]) {
    it(`${file} reaches no reason or tag module and names no reason source or kind`, () => {
      const modules = [...closure(join(driftDir, file))];
      expect(modules.filter((m) => /reason/i.test(m))).toEqual([]);
      for (const module of modules) {
        expect(
          readFileSync(module, "utf8").match(/drift-reason|reason_tag|reasonKey|resolveReasons|resolveReasonTags/)?.[0],
          module
        ).toBeUndefined();
      }
    });
  }

  it("the reason modules reach no rule, evaluation, episode or planning module, and import nothing from outside the folder", () => {
    for (const file of ["drift-reasons.ts", "drift-reason-tags.ts"]) {
      const modules = [...closure(join(driftDir, file))];
      expect(
        modules.filter((m) => m.startsWith("external:")),
        file
      ).toEqual([]);
      expect(
        modules.filter((m) => /drift-(rules|eval|episodes|labels)|planning/.test(m)),
        file
      ).toEqual([]);
    }
  });

  it("no module outside the reason store and service, and the activity store's own reads, deletes and retention exemption, names the reason source", () => {
    const portalRoot = join(resolve(here, "..", ".."), "");
    const allowed = new Set([
      "server/drift/drift-reasons.ts",
      "server/drift/reason-tag-runner.ts",
      "server/persistence/postgres/drift-reason-store.ts",
      "server/persistence/postgres/activity-store.ts",
      "server/persistence/postgres/activity-retention-store.ts"
    ]);
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
          return ["node_modules", ".next", ".vinext", "dist"].includes(entry.name) ? [] : walk(path);
        return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
      });
    const offenders = walk(portalRoot)
      .filter((path) => /["'`]drift-reason["'`]|reason_tag/.test(readFileSync(path, "utf8")))
      .map((path) =>
        path
          .slice(portalRoot.length)
          .replace(/^[\\/]/, "")
          .split("\\")
          .join("/")
      )
      .filter((path) => !allowed.has(path));
    expect(offenders).toEqual([]);
  });
});
