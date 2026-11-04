import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommandModule } from "./command-modules.js";
import { registerCommandModule } from "./registry.js";

/**
 * Loads the folders under `tools/cli/extensions/` at run time, for the entry points that run under plain tsx,
 * which cannot resolve the glob in `drop-ins.ts`. Registering is idempotent, so a host that already has the
 * modules (Vite, the bundle) can call this too.
 */
export async function loadDropInsFromDisk(): Promise<void> {
  const directory = fileURLToPath(new URL("../extensions/", import.meta.url));
  if (!existsSync(directory)) return;
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const name of names) {
    const file = new URL(`../extensions/${name}/command-module.ts`, import.meta.url);
    if (!existsSync(fileURLToPath(file))) continue;
    const loaded = (await import(file.href)) as { default?: CommandModule };
    if (loaded.default) registerCommandModule(loaded.default);
  }
}
