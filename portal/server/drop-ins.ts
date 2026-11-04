/**
 * Loads every drop-in: a folder `drop-ins/<name>/register.ts` that registers itself with one of the portal's
 * registries (a push transport, agent-route classifications, MCP routes) when it is imported. Shared code reaches
 * a drop-in only through those registries, so this repository builds, and its tests pass, with the folder empty.
 *
 * Import this module for its effect before reading a registry. The glob is resolved by the bundler (Vite, in the
 * build, the dev server and the tests), so a drop-in that is not on disk simply is not in the bundle.
 */
const dropIns = import.meta.glob("../drop-ins/*/register.ts", { eager: true });

/** The folders that loaded, for the test that proves the seam works with none. */
export const loadedDropIns: string[] = Object.keys(dropIns).map((path) => path.split("/").at(-2) as string);
