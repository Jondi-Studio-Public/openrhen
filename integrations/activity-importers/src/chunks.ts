import { StringDecoder } from "node:string_decoder";
import { ImportReadError, type ByteSource } from "./types.js";

/** Decodes a byte or text source to strings, keeping multi-byte characters whole across chunk boundaries. */
export async function* textChunks(source: ByteSource): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let first = true;
  for await (const chunk of source) {
    let text =
      typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    if (first && text.length > 0) {
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      first = false;
    }
    if (text) yield text;
  }
  const rest = decoder.end();
  if (rest) yield rest;
}

/** Reads a whole (small) source to a string. */
export async function readText(source: ByteSource, maxChars = 64 * 1024 * 1024): Promise<string> {
  let out = "";
  for await (const part of textChunks(source)) {
    out += part;
    if (out.length > maxChars)
      throw new ImportReadError(
        `A file that should be small is over ${maxChars} characters; it is not the file this importer expects.`
      );
  }
  return out;
}
