import { textChunks } from "./chunks.js";
import type { ByteSource } from "./types.js";

/**
 * Streams the records of an RFC 4180 CSV file: quoted fields may hold commas, doubled quotes and line breaks;
 * records end at CRLF, LF or CR. A blank line is not a record. `onEnd` says whether the file ended inside an open
 * quote (a cut-off file); the half-read record is dropped in that case. A field over `MAX_FIELD_CHARS` makes its record skipped, reported to `onOversize`.
 */
/** The longest field kept; a record with a longer one is skipped (a real field is far shorter). */
export const MAX_FIELD_CHARS = 1_000_000;

export async function* csvRecords(
  source: ByteSource,
  onEnd: (info: { truncated: boolean }) => void = () => undefined,
  onOversize: () => void = () => undefined
): AsyncGenerator<string[]> {
  let field = "";
  let oversize = false;
  const append = (text: string) => {
    if (field.length < MAX_FIELD_CHARS) field += text;
    else oversize = true;
  };
  let record: string[] = [];
  let inQuotes = false;
  let justClosedQuote = false;
  let afterCr = false;
  let fieldStarted = false;
  for await (const chunk of textChunks(source)) {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i]!;
      if (afterCr) {
        afterCr = false;
        if (ch === "\n") continue;
      }
      if (inQuotes) {
        if (ch === '"') {
          inQuotes = false;
          justClosedQuote = true;
        } else append(ch);
        continue;
      }
      if (ch === '"') {
        if (justClosedQuote) {
          append('"'); // a doubled quote inside a quoted field
          inQuotes = true;
          justClosedQuote = false;
        } else if (!fieldStarted) {
          inQuotes = true;
          fieldStarted = true;
        } else append(ch); // a stray quote inside an unquoted field is kept as text
        continue;
      }
      justClosedQuote = false;
      if (ch === ",") {
        record.push(field);
        field = "";
        fieldStarted = false;
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r") afterCr = true;
        if (oversize) onOversize();
        else if (record.length > 0 || field !== "" || fieldStarted) {
          record.push(field);
          yield record;
        }
        oversize = false;
        record = [];
        field = "";
        fieldStarted = false;
      } else {
        append(ch);
        fieldStarted = true;
      }
    }
  }
  if (inQuotes) {
    onEnd({ truncated: true });
    return;
  }
  if (oversize) onOversize();
  else if (record.length > 0 || field !== "" || fieldStarted) {
    record.push(field);
    yield record;
  }
  onEnd({ truncated: false });
}

/** Maps a header row to column positions by lower-cased, trimmed name; the first of duplicate names wins. */
export function headerIndex(header: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  header.forEach((name, position) => {
    const key = name.trim().toLowerCase();
    if (!index.has(key)) index.set(key, position);
  });
  return index;
}
