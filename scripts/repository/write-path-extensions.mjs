/**
 * Registry of the write paths a feature the OpenRhen export leaves out adds to the write-path registry.
 * `private/index.mjs` registers each on import; the export excludes that folder and ships an empty `index.mjs`.
 */
const writers = {};

export function registerWriters(entries) {
  Object.assign(writers, entries);
}

export function extensionWriters() {
  return writers;
}
