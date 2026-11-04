import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Loads every drop-in: a folder `drop-ins/<name>/register.ts` that registers its routes with the proxy
 * (`host/route-registry.ts`) when it is imported. Shared code reaches a drop-in only through the registry, so the
 * proxy builds, and its tests pass, with the folder empty or absent.
 *
 * This file is what tests and `tsx` run: it lists the folder and imports each entry. The production bundle
 * (`scripts/build.mjs`) replaces it with one static import per folder present at build time, since a bundle has no
 * folder to list.
 */
const root = fileURLToPath(new URL("./drop-ins/", import.meta.url));

/** The folders that loaded, for the test that proves the seam works with none. */
export const loadedDropIns: string[] = [];

for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
  const entry = join(root, name, "register.ts");
  if (!existsSync(entry)) continue;
  await import(pathToFileURL(entry).href);
  loadedDropIns.push(name);
}
