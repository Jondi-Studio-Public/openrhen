import { textChunks } from "./chunks.js";
import type { ByteSource } from "./types.js";

export interface XmlTag {
  name: string;
  attrs: Record<string, string>;
}

const ATTRIBUTE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
/** The longest tag text read into memory before the file is declared not to be XML. */
const MAX_TAG_CHARS = 1024 * 1024;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/**
 * Streams the start tags of an XML document (a self-closing tag counts as one) without a DOM, so a multi-gigabyte
 * Apple Health `export.xml` costs only its current tag in memory. Text between tags, end tags, comments,
 * processing instructions, CDATA and the DOCTYPE (with its internal subset) are skipped. Attribute values are
 * entity-decoded. `onEnd` says whether the file ended inside a tag. A tag that is never closed for a megabyte
 * means the file is not XML and throws.
 */
export async function* xmlStartTags(
  source: ByteSource,
  onEnd: (info: { truncated: boolean }) => void = () => undefined
): AsyncGenerator<XmlTag> {
  let buffer = "";
  for await (const chunk of textChunks(source)) {
    buffer += chunk;
    let position = 0;
    for (;;) {
      const open = buffer.indexOf("<", position);
      if (open === -1) {
        position = buffer.length;
        break;
      }
      const end = tagEnd(buffer, open);
      if (end === -1) {
        position = open;
        if (buffer.length - open > MAX_TAG_CHARS)
          throw new Error("This does not look like XML: a tag is never closed.");
        break;
      }
      const text = buffer.slice(open, end + 1);
      position = end + 1;
      const tag = parseStartTag(text);
      if (tag) yield tag;
    }
    buffer = buffer.slice(position);
  }
  // What is left starts at an unfinished tag (or is plain text with no tag in it).
  onEnd({ truncated: buffer.includes("<") });
}

/** Index of the `>` that closes the markup starting at `open`, or -1 when more input is needed. */
function tagEnd(buffer: string, open: number): number {
  if (buffer.startsWith("<!--", open)) {
    const close = buffer.indexOf("-->", open + 4);
    return close === -1 ? -1 : close + 2;
  }
  if (buffer.startsWith("<![CDATA[", open)) {
    const close = buffer.indexOf("]]>", open + 9);
    return close === -1 ? -1 : close + 2;
  }
  if (buffer.startsWith("<?", open)) {
    const close = buffer.indexOf("?>", open + 2);
    return close === -1 ? -1 : close + 1;
  }
  if (buffer.startsWith("<!", open)) {
    // DOCTYPE: the internal subset in [ ... ] holds its own > characters.
    let depth = 0;
    for (let i = open + 2; i < buffer.length; i += 1) {
      const ch = buffer[i];
      if (ch === "[") depth += 1;
      else if (ch === "]") depth -= 1;
      else if (ch === ">" && depth <= 0) return i;
    }
    return -1;
  }
  let quote: string | null = null;
  for (let i = open + 1; i < buffer.length; i += 1) {
    const ch = buffer[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ">") return i;
  }
  return -1;
}

function parseStartTag(text: string): XmlTag | null {
  if (text.startsWith("<!") || text.startsWith("<?") || text.startsWith("</")) return null;
  const nameMatch = /^<([A-Za-z_][\w:.-]*)/.exec(text);
  if (!nameMatch) return null;
  const attrs: Record<string, string> = {};
  ATTRIBUTE.lastIndex = nameMatch[0].length;
  for (let match = ATTRIBUTE.exec(text); match; match = ATTRIBUTE.exec(text))
    attrs[match[1]!] = decodeEntities(match[2] ?? match[3] ?? "");
  return { name: nameMatch[1]!, attrs };
}
