import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { mcpManifestTool, validateToolArguments } from "@openrhen/contracts";

/**
 * "Agents never guess": every 409 an MCP agent can receive names the cause and the exact next call. This reads the
 * portal's own source, so a new bare `new CommandConflictError("...")` fails here the day it is written.
 */

const SERVER_ROOT = join(__dirname, "..", "..");

/** Sites allowed to stay bare, each with the reason. Keep this empty: a bare conflict makes the agent guess. */
const EXEMPT: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "node_modules") out.push(...sourceFiles(path));
    } else if (path.endsWith(".ts") && !/\.(test|integration\.test|d)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

/** Index just past the end of a string, template, or comment that starts at `i`, else `i`. */
function skipQuoted(src: string, i: number): number {
  const c = src[i];
  if (c === "/" && src[i + 1] === "/") return src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
  if (c === "/" && src[i + 1] === "*") return src.indexOf("*/", i + 2) + 2;
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    while (src[j] !== "`") {
      if (src[j] === "\\") j += 2;
      else if (src[j] === "$" && src[j + 1] === "{") j = skipBalanced(src, j + 1) + 1;
      else j += 1;
    }
    return j + 1;
  }
  return i;
}

/** Index of the bracket closing the one at `open`. */
function skipBalanced(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length;) {
    const next = skipQuoted(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if ("([{".includes(src[i]!)) depth += 1;
    else if (")]}".includes(src[i]!) && --depth === 0) return i;
    i += 1;
  }
  throw new Error("unbalanced source");
}

/** The top-level arguments of the call whose "(" is at `open`, as source text. */
function callArguments(src: string, open: number): string[] {
  const end = skipBalanced(src, open);
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < end;) {
    const next = skipQuoted(src, i);
    if (next !== i) {
      i = next;
      continue;
    }
    if ("([{".includes(src[i]!)) depth += 1;
    else if (")]}".includes(src[i]!)) depth -= 1;
    else if (src[i] === "," && depth === 0) {
      args.push(src.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }
  const last = src.slice(start, end).trim();
  if (last !== "") args.push(last);
  return args;
}

const parsed = sourceFiles(SERVER_ROOT).map((file) => ({
  file: relative(SERVER_ROOT, file).replaceAll("\\", "/"),
  source: readFileSync(file, "utf8")
}));

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

describe("every CommandConflictError the portal throws", () => {
  it("carries a nextCall or the stored currentVersion", () => {
    const bare: string[] = [];
    for (const { file, source } of parsed)
      for (const match of source.matchAll(/new CommandConflictError\(/g)) {
        const [message = "", options = ""] = callArguments(source, match.index! + match[0].length - 1);
        const line = lineOf(source, match.index!);
        if (/nextCall|currentVersion/.test(options) || EXEMPT[`${file}:${line}`]) continue;
        bare.push(`${file}:${line}  ${message.slice(0, 90)}`);
      }
    expect(bare, "give each a { nextCall } (see command-errors.ts), or say exactly what repeats").toEqual([]);
  });

  it("keeps the exemption list empty", () => {
    expect(Object.keys(EXEMPT)).toEqual([]);
  });

  it("every next call written in portal/server is a manifest tool, and its literal arguments pass the tool's schema", () => {
    let checked = 0;
    for (const { file, source } of parsed)
      for (const match of source.matchAll(/tool:\s*"(rhen_[a-z_]+)",\s*arguments:\s*(\{)/g)) {
        const label = `${file}:${lineOf(source, match.index!)}`;
        const entry = mcpManifestTool(match[1]!);
        expect(entry, `${label}: ${match[1]} is a manifest tool`).toBeDefined();
        const open = match.index! + match[0].length - 1;
        const text = source.slice(open, skipBalanced(source, open) + 1);
        if (text.includes('"<')) continue; // an illustrative placeholder, not a call
        let value: unknown;
        try {
          value = new Function(`return (${text})`)();
        } catch {
          continue; // arguments built from variables: only the tool name can be checked here
        }
        const result = validateToolArguments(entry!.inputSchema, value as Record<string, unknown>, entry!.name);
        expect(result.ok, `${label}: ${text} ${result.ok ? "" : result.error}`).toBe(true);
        checked += 1;
      }
    expect(checked).toBeGreaterThan(5);
  });
});
