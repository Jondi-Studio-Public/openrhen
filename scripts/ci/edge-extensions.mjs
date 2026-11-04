/**
 * Registry of extra dependency edges for the affected-suites selector (`affected.mjs`) that belong to packages the
 * OpenRhen export leaves out. `private/index.mjs` registers each on import; the export excludes that folder and ships
 * an empty `index.mjs`, so the selector there holds only the core edges.
 */
const edges = [];

/** `{ from, to, suite }`, the same shape as an `EXTRA_EDGES` entry. */
export function registerEdge(edge) {
  edges.push(edge);
}

export function edgeExtensions() {
  return edges;
}
