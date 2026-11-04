import { registerNavExtension, type NavExtension } from "./nav-extensions";

/**
 * Navigation for add-on pages. An add-on that keeps its pages under `app/(addon)/<id>/` adds a `nav.ts` beside them
 * whose default export is a `NavExtension` (palette destinations, search words, the place a path belongs to). This
 * file finds every such `nav.ts` at build time and registers it, so a page shows up in the palette and highlights
 * its place without any core file changing. The glob is resolved by the bundler (Vite, in the build, the dev server
 * and the tests): with no add-on on disk it matches nothing. `nav.ts` imports types from `./nav-extensions` only.
 */
const modules = import.meta.glob<{ default?: NavExtension }>("../app/\\(addon\\)/**/nav.ts", { eager: true });

/** Registers each module's default export. Returns the folder name each came from, for the test and for doctor. */
export function registerAddonNav(found: Record<string, { default?: NavExtension }>): string[] {
  const folders: string[] = [];
  for (const [path, module] of Object.entries(found)) {
    if (!module.default) continue;
    registerNavExtension(module.default);
    folders.push(path.split("/").at(-2) as string);
  }
  return folders;
}

export const addonNavFolders: string[] = registerAddonNav(modules);
