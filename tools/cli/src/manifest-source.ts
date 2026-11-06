import { MCP_COMMON_PARAMS } from "@openrhen/contracts";

/** A stand-in for a shared parameter text while the tree is written out as JSON; it cannot occur in real text. */
const MARK = "\u0001common-param:";

/** The tree with each string that is exactly one of the shared write-parameter texts swapped for a stand-in. */
function markCommonParams(value: unknown, texts: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") {
    const key = texts.get(value);
    return key === undefined ? value : `${MARK}${key}`;
  }
  if (Array.isArray(value)) return value.map((item) => markCommonParams(item, texts));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, markCommonParams(item, texts)]));
  return value;
}

/**
 * TypeScript source for a list of manifest entries, where each string equal to a shared write-parameter text is
 * written as `MCP_COMMON_PARAMS["<name>"]` instead of the text. The swap is made on the object tree before it is
 * serialised, never on the JSON text. `usesCommonParams` says whether the generated file needs the import.
 */
export function manifestSource(
  entries: readonly unknown[],
  common: Readonly<Record<string, string>> = MCP_COMMON_PARAMS
): { source: string; usesCommonParams: boolean } {
  const texts = new Map(Object.entries(common).map(([key, text]) => [text, key]));
  const marked = JSON.stringify(markCommonParams(entries, texts), null, 2);
  let usesCommonParams = false;
  const source = marked.replace(/"\\u0001common-param:((?:[^"\\]|\\.)*)"/g, (_whole, escaped: string) => {
    usesCommonParams = true;
    return `MCP_COMMON_PARAMS[${JSON.stringify(JSON.parse(`"${escaped}"`))}]`;
  });
  return { source, usesCommonParams };
}
