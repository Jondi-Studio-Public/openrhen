import { planForecastRequestSchema } from "@openrhen/contracts";
import { calculatePlanAndForecast } from "../../src/index.js";

/**
 * Tracks which fields of the request `state` the engine reads. A recursive Proxy records every
 * property read (`get`, `has`) and every enumeration (`ownKeys`), and the engine is run over every
 * synthetic snapshot-replay fixture. The result is a LOWER BOUND: it holds only what these fixtures
 * made the engine touch, so a field read on a rare branch no fixture reaches is missing.
 */

/**
 * `@types/node` is not a dependency of this package, so the builtins load through a non-literal
 * dynamic `import()` (the same approach as `test/architecture/commitment-edges.test.ts`).
 */
interface FsModule {
  readdirSync(path: string): string[];
  readFileSync(path: string, encoding: "utf8"): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: true }): void;
  existsSync(path: string): boolean;
}
interface PathModule {
  resolve(...paths: string[]): string;
  dirname(path: string): string;
}
const nodeModule = <T>(specifier: string): Promise<T> => import(specifier) as Promise<T>;
export const fs = await nodeModule<FsModule>("node:fs");
const { resolve, dirname } = await nodeModule<PathModule>("node:path");
const { fileURLToPath } = await nodeModule<{ fileURLToPath(url: string): string }>("node:url");
export const updateRequested =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.UPDATE_ENGINE_STATE_READS ===
  "1";

const here = dirname(fileURLToPath(import.meta.url));
export const docsDirectory = resolve(here, "../../docs");
export const jsonPath = resolve(docsDirectory, "engine-state-reads.json");
export const markdownPath = resolve(docsDirectory, "engine-state-reads.md");
export const regenerateCommand =
  "UPDATE_ENGINE_STATE_READS=1 corepack pnpm --filter @openrhen/engine-core exec vitest run test/snapshot-replay/state-reads.test.ts";

export const lowerBoundLabel =
  "Lower bound: fields read by these fixtures. A field read only on a rare branch may be missing. " +
  "Fields the engine reads only after copying an item out of state (for example routine steps and sleep plans) can also be missing; the table never over-reports.";

export interface StateReads {
  fixtures: string[];
  /** Every leaf read path (array indices collapsed to `[]`) with the number of fixtures that read it. */
  paths: Array<{ path: string; fixtures: number }>;
  /** Top-level `state` collections (arrays and objects) and the fields read beneath each. */
  collections: Array<{ name: string; fields: string[] }>;
  /** Fields read directly under `state.settings`. */
  settings: string[];
  /** Top-level `state` scalars and objects read as a whole, with no field beneath them read. */
  scalars: string[];
}

const INDEX = /^(0|[1-9]\d*)$/u;

/** Wraps `value` so reads land in `reads` (as collapsed paths) and `enumerated` (paths listed whole). */
function track(value: unknown, path: string, reads: Set<string>): unknown {
  if (value === null || typeof value !== "object") return value;
  const cache = new Map<string, unknown>();
  // A spread or JSON.stringify asks for the descriptor and then reads the value; that is a copy, not
  // a use, so the read that directly follows a descriptor request is not recorded. Whatever later
  // uses the copied children is recorded through their own proxies.
  let copying: string | null = null;
  return new Proxy(value as object, {
    get(target, key, receiver) {
      if (typeof key === "symbol") return Reflect.get(target, key, receiver);
      const isArray = Array.isArray(target);
      let name: string | null;
      if (isArray) name = INDEX.test(key) ? "[]" : null;
      else name = key === "toJSON" || (key in Object.prototype && !Object.hasOwn(target, key)) ? null : key;
      const raw = Reflect.get(target, key, receiver);
      if (name === null) return raw;
      const childPath = isArray ? `${path}[]` : `${path}.${name}`;
      if (copying === key) copying = null;
      else reads.add(childPath);
      if (raw === null || typeof raw !== "object") return raw;
      const cached = cache.get(key);
      if (cached) return cached;
      const wrapped = track(raw, childPath, reads);
      cache.set(key, wrapped);
      return wrapped;
    },
    getOwnPropertyDescriptor(target, key) {
      if (typeof key === "string") copying = key;
      return Reflect.getOwnPropertyDescriptor(target, key);
    }
  });
}

export function readsForFixture(request: unknown): Set<string> {
  const parsed = planForecastRequestSchema.parse(request);
  const reads = new Set<string>();
  calculatePlanAndForecast({ ...parsed, state: track(parsed.state, "state", reads) as typeof parsed.state });
  return reads;
}

export function fixtureFiles(): string[] {
  const root = resolve(here);
  const synthetic = resolve(root, "synthetic");
  return [
    ...fs.readdirSync(root).filter((name: string) => name.endsWith(".json")),
    ...fs
      .readdirSync(synthetic)
      .filter((name: string) => name.endsWith(".json"))
      .map((name: string) => `synthetic/${name}`)
  ].sort();
}

export function collectStateReads(): StateReads {
  const counts = new Map<string, number>();
  const files = fixtureFiles();
  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(resolve(here, file), "utf8")) as { request: unknown };
    for (const path of readsForFixture(fixture.request)) counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  const all = [...counts.keys()].sort();
  // A path is a leaf when no other read path extends it.
  const leaves = all.filter(
    (path) => !all.some((other) => other.startsWith(`${path}.`) || other.startsWith(`${path}[]`))
  );
  const paths = leaves.map((path) => ({ path, fixtures: counts.get(path)! }));
  const top = (path: string) => path.split(/[.[]/u)[1]!;
  const names = [...new Set(all.map(top))].sort();
  const collections = names
    .map((name: string) => ({
      name,
      fields: leaves
        .filter((path) => top(path) === name && path !== `state.${name}`)
        .map((path) => path.slice(`state.${name}`.length).replace(/^\./u, ""))
    }))
    .filter((entry) => entry.fields.length > 0 && entry.name !== "settings");
  const settings = leaves
    .filter((path) => path.startsWith("state.settings."))
    .map((path) => path.slice("state.settings.".length));
  const scalars = leaves.filter((path) => /^state\.[^.[]+$/u.test(path)).map((path) => path.slice("state.".length));
  return { fixtures: files, paths, collections, settings, scalars };
}

export function renderJson(reads: StateReads): string {
  return `${JSON.stringify({ note: lowerBoundLabel, regenerate: regenerateCommand, ...reads }, null, 2)}\n`;
}

export function renderMarkdown(reads: StateReads): string {
  const lines = [
    "# Engine state reads",
    "",
    `> ${lowerBoundLabel}`,
    "",
    "Generated by `engine/core/test/snapshot-replay/state-reads.test.ts`: the request `state` is wrapped in a",
    "read-tracking Proxy and `calculatePlanAndForecast` runs over every synthetic snapshot-replay fixture",
    `(${reads.fixtures.length} files). Array indices are collapsed to \`[]\`. The full table is in \`engine-state-reads.json\`.`,
    "Do not edit by hand. Regenerate (on Windows set the variable first, then remove it):",
    "",
    "```sh",
    regenerateCommand,
    "```",
    "",
    `## Collections read (${reads.collections.length})`,
    ""
  ];
  for (const { name, fields } of reads.collections) {
    lines.push(`### \`state.${name}\``, "", fields.map((field) => `\`${field || "(whole)"}\``).join(", "), "");
  }
  lines.push(
    `## Settings fields read (${reads.settings.length})`,
    "",
    reads.settings.map((field) => `\`${field}\``).join(", "),
    ""
  );
  lines.push(
    `## Top-level values read directly (${reads.scalars.length})`,
    "",
    reads.scalars.map((field) => `\`${field}\``).join(", "),
    ""
  );
  return `${lines.join("\n")}\n`;
}
