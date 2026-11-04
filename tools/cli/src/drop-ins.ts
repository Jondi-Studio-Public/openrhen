import type { CommandModule } from "./command-modules.js";

/**
 * The command modules dropped into `tools/cli/extensions/<name>/command-module.ts`. With none dropped in, the
 * list is empty and the CLI is the core CLI.
 *
 * Three ways this file is satisfied, because three tools run the CLI:
 *  - Vite (vitest, the portal's build and dev server) rewrites `import.meta.glob` below into static imports.
 *  - The esbuild bundle (`scripts/build.mjs`) replaces this whole module with a generated list of the same folders.
 *  - Plain tsx has neither, so `import.meta.glob` throws and the list is empty here; `drop-ins-disk.ts` then
 *    loads the folders at start from the entry points that run under tsx (`dev.ts`, the generator scripts).
 */
export function dropInModules(): CommandModule[] {
  try {
    const found = import.meta.glob("../extensions/*/command-module.ts", { eager: true, import: "default" });
    return Object.keys(found)
      .sort()
      .map((path) => found[path] as CommandModule);
  } catch {
    return [];
  }
}
