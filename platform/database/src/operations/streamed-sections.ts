import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";

/**
 * A backed-up table too large for the one-string JSON backup lives in its own NDJSON file next to it: one row per line,
 * in the table's primary-key order, written straight from a Postgres cursor and read straight back into inserts, so
 * memory stays flat however many rows there are. The JSON backup (the manifest) records the file, its row count, its
 * byte size and the sha256 of its bytes; `db:restore:verify` recomputes all three before it touches a database.
 */
export interface StreamedSection {
  /** The file's name, in the same directory as the JSON backup. */
  file: string;
  rows: number;
  bytes: number;
  sha256: string;
}

/** Rows per cursor fetch when writing, and per INSERT when restoring. */
export const STREAM_BATCH_ROWS = 2000;

/** The section file for a JSON backup path: `<backup without .json>.<table with _ as ->.ndjson`. */
export function sectionFileName(backupFile: string, table: string): string {
  return `${backupFile.replace(/\.json$/, "")}.${table.replaceAll("_", "-")}.ndjson`;
}

/**
 * Writes batches of rows to `path` atomically (`.partial`, fsync, rename), hashing the bytes as they go. Each row is one
 * `JSON.stringify` line, so a restore that reads the table back and serialises it the same way gets the same bytes.
 */
export async function writeSection(
  path: string,
  batches: AsyncIterable<readonly Record<string, unknown>[]>
): Promise<Omit<StreamedSection, "file">> {
  const partial = `${path}.partial`;
  const handle = await open(partial, "wx");
  const hash = createHash("sha256");
  let rows = 0;
  let bytes = 0;
  try {
    try {
      for await (const batch of batches) {
        if (batch.length === 0) continue;
        const text = `${batch.map((row) => JSON.stringify(row)).join("\n")}\n`;
        const buffer = Buffer.from(text, "utf8");
        hash.update(buffer);
        await handle.write(buffer);
        rows += batch.length;
        bytes += buffer.length;
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return { rows, bytes, sha256: hash.digest("hex") };
}

/** What a section file actually holds, filled in once its rows have all been read. */
export interface SectionReadback {
  rows: number;
  bytes: number;
  sha256: string;
}

/**
 * Reads a section file in batches of parsed rows. `readback` is filled in as the file is consumed, so it is complete
 * once the iteration ends. A blank or unparsable line throws, naming its line number.
 */
export async function* readSection(
  path: string,
  readback: SectionReadback,
  batchRows: number = STREAM_BATCH_ROWS
): AsyncGenerator<Record<string, unknown>[]> {
  const hash = createHash("sha256");
  const decoder = new StringDecoder("utf8");
  let rest = "";
  let batch: Record<string, unknown>[] = [];
  let line = 0;
  readback.rows = 0;
  readback.bytes = 0;
  const take = (text: string) => {
    line += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} line ${line} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${path} line ${line} is not a row object`);
    batch.push(parsed as Record<string, unknown>);
    readback.rows += 1;
  };
  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    readback.bytes += buffer.length;
    rest += decoder.write(buffer);
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      take(rest.slice(0, at));
      rest = rest.slice(at + 1);
      if (batch.length >= batchRows) {
        const full = batch;
        batch = [];
        yield full;
      }
    }
  }
  rest += decoder.end();
  if (rest.length > 0) throw new Error(`${path} ends in the middle of a line (the file is truncated)`);
  readback.sha256 = hash.digest("hex");
  if (batch.length) yield batch;
}

/** Streams a section end to end without keeping rows, and throws unless its rows, bytes and sha256 match the manifest. */
export async function verifySection(path: string, expected: StreamedSection): Promise<void> {
  const readback: SectionReadback = { rows: 0, bytes: 0, sha256: "" };
  for await (const _batch of readSection(path, readback)) void _batch;
  if (readback.bytes !== expected.bytes)
    throw new Error(`${expected.file} is ${readback.bytes} bytes but the backup recorded ${expected.bytes}`);
  if (readback.sha256 !== expected.sha256) throw new Error(`${expected.file} checksum does not match the backup`);
  if (readback.rows !== expected.rows)
    throw new Error(`${expected.file} holds ${readback.rows} rows but the backup recorded ${expected.rows}`);
}
