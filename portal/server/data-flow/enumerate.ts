import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";

/**
 * The data-flow registry's enumerators and closure walker (design 3.1, 3.2, 3.4): pure filesystem and regex work, no
 * database. It reads source text, never runs it. The coverage test (`registry-coverage.test.ts`) feeds it the real
 * repository; `enumerate.test.ts` feeds it fixture trees.
 */

export type StopReason = "pipe" | "infra" | "overlay" | "seam";

export interface ImportEdge {
  specifier: string;
  /** The names taken from the module, or `all` for a namespace, side-effect, dynamic or `export *` edge. */
  names: string[] | "all";
}

export interface WalkOptions {
  /** The repository root (or a fixture tree's root). */
  root: string;
  /** Repo-relative modules the walk reaches but does not scan, each with why. */
  stops?: ReadonlyMap<string, StopReason>;
  /** Defaults to 6. */
  maxDepth?: number;
}

export interface Closure {
  /** Repo-relative files scanned, sorted. */
  files: string[];
  /** Stop modules reached, sorted by path. */
  stopped: { path: string; reason: StopReason }[];
  /** Files at the depth cap that still had imports to follow. */
  truncated: string[];
}

const SEAM = /(?:^|\/)private\/index\.ts$/;

export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function namesOf(list: string): string[] {
  return list
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "" && !/^type\s/.test(item))
    .map((item) => item.split(/\s+as\s+/)[0]!.trim());
}

/** The modules a file takes from, with the names; `import type` and `export type` are left out. */
export function parseImports(source: string): ImportEdge[] {
  const text = stripComments(source);
  const pattern =
    /\bimport\s+(type\s+)?([^"';]*?)\s*from\s*(["'])([^"']+)\3|\bimport\s*(["'])([^"']+)\5|\bexport\s+(type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(["'])([^"']+)\9|\bimport\(\s*(["'])([^"']+)\11\s*\)/g;
  const edges: ImportEdge[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match[4] !== undefined) {
      if (match[1]) continue;
      const clause = match[2]!.trim();
      if (/^\*\s+as\s+\w+$/.test(clause)) {
        edges.push({ specifier: match[4], names: "all" });
        continue;
      }
      const brace = clause.indexOf("{");
      const head = (brace === -1 ? clause : clause.slice(0, brace)).replace(/,\s*$/, "").trim();
      const names = [
        ...(head !== "" ? ["default"] : []),
        ...(brace === -1 ? [] : namesOf(clause.slice(brace + 1, clause.lastIndexOf("}"))))
      ];
      edges.push({ specifier: match[4], names });
    } else if (match[6] !== undefined) edges.push({ specifier: match[6], names: "all" });
    else if (match[10] !== undefined) {
      if (match[7]) continue;
      const clause = match[8]!;
      edges.push({
        specifier: match[10],
        names: clause.startsWith("*") ? "all" : namesOf(clause.slice(1, clause.lastIndexOf("}")))
      });
    } else if (match[12] !== undefined) edges.push({ specifier: match[12], names: "all" });
  }
  return edges;
}

/** Local binding to module and imported name, for the value imports of one file. */
function importedBindings(source: string): Map<string, { specifier: string; imported: string }> {
  const text = stripComments(source);
  const bindings = new Map<string, { specifier: string; imported: string }>();
  for (const match of text.matchAll(/\bimport\s+(?!type\s)([^"';]*?)\s*from\s*(["'])([^"']+)\2/g)) {
    const clause = match[1]!.trim();
    const brace = clause.indexOf("{");
    const head = (brace === -1 ? clause : clause.slice(0, brace)).replace(/,\s*$/, "").trim();
    if (head !== "" && !head.startsWith("*")) bindings.set(head, { specifier: match[3]!, imported: "default" });
    if (brace === -1) continue;
    for (const item of clause.slice(brace + 1, clause.lastIndexOf("}")).split(",")) {
      const trimmed = item.trim();
      if (trimmed === "" || /^type\s/.test(trimmed)) continue;
      const [imported, local] = trimmed.split(/\s+as\s+/).map((part) => part.trim());
      bindings.set(local ?? imported!, { specifier: match[3]!, imported: imported! });
    }
  }
  return bindings;
}

/** The tables a source text writes: SQL `INSERT INTO`, `UPDATE`, `DELETE FROM` (plain or `schema.table`) and drizzle `.insert(table)` calls. */
export function tablesWrittenIn(
  source: string,
  known: ReadonlySet<string>,
  drizzleNames: ReadonlyMap<string, string>
): Set<string> {
  const text = stripComments(source);
  const found = new Set<string>();
  // `schema.table` counts as written when `known` names it that way; `public.table` is the plain `table`.
  for (const match of text.matchAll(
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_][a-z0-9_]*)"?(?:\s*\.\s*"?([a-z_][a-z0-9_]*)"?)?/g
  )) {
    const [, first, second] = match;
    if (second === undefined) {
      if (known.has(first!)) found.add(first!);
    } else if (known.has(`${first}.${second}`)) found.add(`${first}.${second}`);
    else if (first === "public" && known.has(second)) found.add(second);
  }
  for (const match of text.matchAll(/\.(?:insert|update|delete)\(\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*\)/g)) {
    const table = drizzleNames.get(match[1]!);
    if (table !== undefined) found.add(table);
  }
  return found;
}

/** The HTTP methods a route file exports. */
export function exportedMethods(source: string): string[] {
  const text = stripComments(source);
  const methods = new Set<string>();
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:const|let|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g))
    methods.add(match[1]!);
  for (const match of text.matchAll(/export\s*\{([^}]*)\}/g))
    for (const item of match[1]!.split(",")) {
      const exported = item
        .trim()
        .split(/\s+as\s+/)
        .at(-1)
        ?.trim();
      if (exported && /^(?:GET|POST|PUT|PATCH|DELETE)$/.test(exported)) methods.add(exported);
    }
  return [...methods];
}

function matchingClose(text: string, open: number, opening: string, closing: string): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === opening) depth += 1;
    else if (text[index] === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** L1: the literal loop names in the worker's `runIndependentLoops([...])` and every `registerExtraLoop({ name })`. */
export function workerLoopNames(mainSource: string, otherSources: readonly string[]): string[] {
  const main = stripComments(mainSource);
  const names: string[] = [];
  const call = main.indexOf("runIndependentLoops(");
  if (call !== -1) {
    const open = main.indexOf("[", call);
    const close = open === -1 ? -1 : matchingClose(main, open, "[", "]");
    if (close !== -1)
      for (const match of main.slice(open, close).matchAll(/\bname:\s*"([^"]+)"/g)) names.push(match[1]!);
  }
  for (const source of otherSources)
    for (const match of stripComments(source).matchAll(/registerExtraLoop\(\s*\{[\s\S]*?\bname:\s*"([^"]+)"/g))
      names.push(match[1]!);
  return [...new Set(names)];
}

/** L2: `namedLoop("name", ...)` calls, the helper each service uses to name a loop. */
export function serviceLoopNames(sources: readonly string[]): string[] {
  const names = sources.flatMap((source) =>
    [...stripComments(source).matchAll(/\bnamedLoop\(\s*"([^"]+)"/g)].map((match) => match[1]!)
  );
  return [...new Set(names)];
}

interface PackageInfo {
  dir: string;
  exports: Record<string, string>;
}

const resolvers = new Map<string, ReturnType<typeof createResolver>>();

/** One resolver per root: it caches file text and the package map, which a whole-repository measurement reuses. */
function resolverFor(root: string) {
  let resolver = resolvers.get(root);
  if (!resolver) {
    resolver = createResolver(root);
    resolvers.set(root, resolver);
  }
  return resolver;
}

function createResolver(root: string) {
  const cache = new Map<string, string>();
  const read = (file: string): string => {
    let text = cache.get(file);
    if (text === undefined) {
      text = stripComments(readFileSync(join(root, file), "utf8"));
      cache.set(file, text);
    }
    return text;
  };
  const isFile = (file: string) => {
    try {
      return statSync(join(root, file)).isFile();
    } catch {
      return false;
    }
  };

  const packages = new Map<string, PackageInfo>();
  for (const group of ["engine", "platform", "integrations", "tools", "."]) {
    const base = group === "." ? [] : safeDirs(join(root, group)).map((name) => `${group}/${name}`);
    for (const dir of group === "." ? ["portal"] : base) {
      const manifest = join(root, dir, "package.json");
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; exports?: unknown; main?: string };
      if (!json.name) continue;
      const exportsMap: Record<string, string> = {};
      if (typeof json.exports === "string") exportsMap["."] = json.exports;
      else if (json.exports && typeof json.exports === "object")
        for (const [key, value] of Object.entries(json.exports)) {
          const target = typeof value === "string" ? value : ((value as Record<string, string>).default ?? "");
          if (target) exportsMap[key] = target;
        }
      if (!exportsMap["."] && json.main) exportsMap["."] = json.main;
      packages.set(json.name, { dir, exports: exportsMap });
    }
  }

  function withExtension(base: string): string | null {
    const stem = base.replace(/\.(?:js|mjs)$/, "");
    const candidates = /\.(?:js|mjs)$/.test(base)
      ? [`${stem}.ts`, `${stem}.tsx`, base]
      : [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`];
    return candidates.find((candidate) => !candidate.endsWith(".json") && isFile(candidate)) ?? null;
  }

  function resolveModule(from: string, specifier: string): string | null {
    if (specifier.startsWith(".")) return withExtension(posix.normalize(posix.join(dirname(from), specifier)));
    if (specifier.startsWith("@/")) return withExtension(`portal/${specifier.slice(2)}`);
    const workspace = /^(@openrhen\/[^/]+)(\/.*)?$/.exec(specifier);
    if (!workspace) return null;
    const pkg = packages.get(workspace[1]!);
    if (!pkg) return null;
    const subpath = workspace[2] ? `.${workspace[2]}` : ".";
    let target = pkg.exports[subpath];
    if (target === undefined)
      for (const [key, value] of Object.entries(pkg.exports)) {
        const star = key.indexOf("*");
        if (star === -1) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix) && subpath.length >= key.length - 1)
          target = value.replace("*", subpath.slice(prefix.length, subpath.length - suffix.length));
      }
    return target === undefined ? null : withExtension(posix.normalize(posix.join(pkg.dir, target)));
  }

  /** The module that defines `name`, followed through `export *` and `export { x } from` re-exports. */
  function findDefinition(file: string, name: string, seen = new Set<string>()): string | null {
    const key = `${file}#${name}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const text = read(file);
    if (name === "default") return /\bexport\s+default\b/.test(text) ? file : null;
    const local = new RegExp(
      `\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|enum|abstract\\s+class)\\s+${name.replace(/\$/g, "\\$")}\\b`
    );
    if (local.test(text)) return file;
    for (const match of text.matchAll(/\bexport\s*\{([^}]*)\}\s*(?:from\s*(["'])([^"']+)\2)?/g)) {
      for (const item of match[1]!.split(",")) {
        const [imported, exported] = item
          .trim()
          .split(/\s+as\s+/)
          .map((part) => part.trim());
        if (!imported || /^type\s/.test(imported) || (exported ?? imported) !== name) continue;
        if (match[3] === undefined) return file;
        const target = resolveModule(file, match[3]);
        return target === null ? null : findDefinition(target, imported, seen);
      }
    }
    for (const match of text.matchAll(/\bexport\s*\*\s*from\s*(["'])([^"']+)\1/g)) {
      const target = resolveModule(file, match[2]!);
      const found = target === null ? null : findDefinition(target, name, seen);
      if (found !== null) return found;
    }
    return null;
  }

  /** A file that only imports and re-exports: reached while resolving a name, never part of a closure itself. */
  function isPureBarrel(file: string): boolean {
    const rest = read(file)
      .replace(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(["'])[^"']+\1\s*;?/g, "")
      .replace(/\bimport\s[^;]*?(["'])[^"']+\1\s*;?/g, "")
      .replace(/\bexport\s*\{\s*\}\s*;?/g, "");
    return rest.trim() === "";
  }

  return { read, isFile, resolveModule, findDefinition, isPureBarrel, withExtension };
}

function safeDirs(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "node_modules")
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function filesUnder(root: string, directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : filesUnder(root, path);
    return /\.(?:ts|tsx|mjs)$/.test(entry.name) && !/\.test\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * The files a set of starting files reaches through relative imports, the portal's `@/` alias and `@openrhen/*`
 * imports. A named import is resolved through re-export barrels to the module that defines it, so a barrel's other
 * modules are not pulled in. It stops at the modules in `stops` and at every `private/index.ts` seam, records them, and
 * does not scan them. Depth is capped (default 6).
 */
export function resolveClosure(starts: readonly string[], options: WalkOptions): Closure {
  const { root } = options;
  const maxDepth = options.maxDepth ?? 6;
  const resolver = resolverFor(root);
  const files = new Set<string>();
  const stopped = new Map<string, StopReason>();
  const truncated = new Set<string>();
  const stopOf = (path: string): StopReason | undefined =>
    options.stops?.get(path) ?? (SEAM.test(path) ? "seam" : undefined);

  let frontier = starts.flatMap((start) => (start.endsWith("/") ? filesUnder(root, start.slice(0, -1)) : [start]));
  const queued = new Set(frontier);
  for (let depth = 0; frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const file of frontier) {
      const reason = stopOf(file);
      if (reason !== undefined) {
        stopped.set(file, reason);
        continue;
      }
      if (!resolver.isFile(file)) continue;
      files.add(file);
      const reached = new Set<string>();
      for (const edge of parseImports(resolver.read(file))) {
        const target = resolver.resolveModule(file, edge.specifier);
        if (target === null) continue;
        if (edge.names === "all") {
          if (stopOf(target) !== undefined || !resolver.isPureBarrel(target)) reached.add(target);
          continue;
        }
        for (const name of edge.names) {
          if (stopOf(target) !== undefined) reached.add(target);
          else if (name === "default") {
            if (!resolver.isPureBarrel(target)) reached.add(target);
          } else {
            const defined = resolver.findDefinition(target, name);
            if (defined !== null) reached.add(defined);
          }
        }
      }
      if (depth >= maxDepth) {
        if ([...reached].some((path) => !queued.has(path))) truncated.add(file);
        continue;
      }
      for (const path of reached)
        if (!queued.has(path)) {
          queued.add(path);
          next.push(path);
        }
    }
    frontier = next;
  }
  return {
    files: [...files].sort(),
    stopped: [...stopped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, reason]) => ({ path, reason })),
    truncated: [...truncated].sort()
  };
}

/** The modules a named loop's `run` expression takes its functions from, to start a closure at. */
export function loopStartFiles(mainFile: string, loopName: string, options: { root: string }): string[] {
  const resolver = resolverFor(options.root);
  const text = resolver.read(mainFile);
  const at = text.search(new RegExp(`\\bname:\\s*"${loopName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  if (at === -1) return [];
  const open = text.lastIndexOf("{", at);
  const close = open === -1 ? -1 : matchingClose(text, open, "{", "}");
  if (close === -1) return [];
  const body = text.slice(at, close);
  const run = body.slice(Math.max(0, body.indexOf("run:")));
  const bindings = importedBindings(text);
  const found = new Set<string>();
  for (const identifier of new Set(run.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
    const binding = bindings.get(identifier);
    if (!binding) continue;
    const target = resolver.resolveModule(mainFile, binding.specifier);
    if (target === null) continue;
    const defined = resolver.findDefinition(target, binding.imported);
    if (defined !== null) found.add(defined);
  }
  return [...found].sort();
}
