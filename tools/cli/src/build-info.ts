import packageJson from "../package.json" with { type: "json" };

/**
 * esbuild `--define`s these three identifiers to string literals at build time (see
 * `scripts/build.mjs`). Under `tsx`/`vitest`, nothing defines them, so they are genuinely undeclared —
 * every read below goes through `typeof`, which is safe on an undeclared identifier and never throws.
 */
declare const __OPENRHEN_VERSION__: string | undefined;
declare const __OPENRHEN_COMMIT__: string | undefined;
declare const __OPENRHEN_BUILT_AT__: string | undefined;

export interface BuildInfo {
  /** Package semver. Falls back to `package.json`'s own version when unbuilt. */
  version: string;
  /** Short git SHA the running bundle was built from. `"dev"` when unbuilt. */
  commit: string;
  /** ISO instant the running bundle was built at. `null` when unbuilt. */
  builtAt: string | null;
}

export const buildInfo: BuildInfo = {
  version: typeof __OPENRHEN_VERSION__ !== "undefined" ? __OPENRHEN_VERSION__ : packageJson.version,
  commit: typeof __OPENRHEN_COMMIT__ !== "undefined" ? __OPENRHEN_COMMIT__ : "dev",
  builtAt: typeof __OPENRHEN_BUILT_AT__ !== "undefined" ? __OPENRHEN_BUILT_AT__ : null
};
