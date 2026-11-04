import { promisify } from "node:util";
import zlib from "node:zlib";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const inflateRaw = promisify(zlib.inflateRaw);
const brotli = promisify(zlib.brotliDecompress);

export class FeedDecodeError extends Error {
  constructor(readonly code: "too_large" | "decode_failed" | "unsupported_encoding") {
    super(`calendar feed ${code}`);
    this.name = "FeedDecodeError";
  }
}

const MAX_CODINGS = 3;

function isGzip(b: Uint8Array): boolean {
  return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b;
}

function codingList(header: string | undefined): string[] {
  const list = (header ?? "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "" && s !== "identity");
  return list;
}

/** Undo Content-Encoding (gzip, x-gzip, deflate, br, in any stack) with a hard cap on decoded bytes.
 * A gzip body served without a Content-Encoding header (a `.ics.gz` link) is detected by its magic bytes. */
export async function decodeBody(
  raw: Buffer,
  contentEncoding: string | undefined,
  maxDecoded: number
): Promise<Buffer> {
  const codings = codingList(contentEncoding);
  if (codings.length > MAX_CODINGS) throw new FeedDecodeError("unsupported_encoding");
  let body = raw;
  const apply = async (fn: () => Promise<Buffer>): Promise<Buffer> => {
    try {
      return await fn();
    } catch (error) {
      const code = (error as { code?: string }).code;
      throw new FeedDecodeError(code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "decode_failed");
    }
  };
  const opts = { maxOutputLength: maxDecoded };
  for (const coding of codings.reverse()) {
    if (coding === "gzip" || coding === "x-gzip") body = await apply(() => gunzip(body, opts));
    else if (coding === "deflate") {
      // Servers disagree: RFC 9110 says zlib-wrapped, some send raw deflate. Try both.
      body = await apply(async () => {
        try {
          return await inflate(body, opts);
        } catch (error) {
          if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw error;
          return inflateRaw(body, opts);
        }
      });
    } else if (coding === "br") body = await apply(() => brotli(body, opts));
    else throw new FeedDecodeError("unsupported_encoding");
  }
  // Header missing or wrong, body still gzip.
  for (let i = 0; isGzip(body); i++) {
    if (i >= MAX_CODINGS) throw new FeedDecodeError("decode_failed");
    body = await apply(() => gunzip(body, opts));
  }
  if (body.length > maxDecoded) throw new FeedDecodeError("too_large");
  return body;
}

const LABELS: Record<string, string> = {
  utf8: "utf-8",
  "utf-8": "utf-8",
  "us-ascii": "utf-8",
  ascii: "utf-8",
  "utf-16": "utf-16le",
  "utf-16le": "utf-16le",
  "utf-16be": "utf-16be",
  "iso-8859-1": "windows-1252",
  latin1: "windows-1252",
  "windows-1252": "windows-1252",
  cp1252: "windows-1252"
};

/** Normalise to BOM-free UTF-8 bytes so the parser can unfold on bytes. A BOM wins over the Content-Type
 * charset; an unknown or absent charset is treated as UTF-8 (the iCalendar default). */
export function toUtf8Bytes(body: Buffer, contentType: string | undefined): Buffer {
  let charset: string | undefined;
  let start = 0;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) {
    charset = "utf-8";
    start = 3;
  } else if (body[0] === 0xff && body[1] === 0xfe) {
    charset = "utf-16le";
    start = 2;
  } else if (body[0] === 0xfe && body[1] === 0xff) {
    charset = "utf-16be";
    start = 2;
  } else {
    const label = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1]?.toLowerCase();
    charset = (label && LABELS[label]) || "utf-8";
  }
  const slice = body.subarray(start);
  if (charset === "utf-8") return Buffer.from(slice);
  return Buffer.from(new TextDecoder(charset).decode(slice), "utf-8");
}
