import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream";
import { createInflateRaw, crc32 } from "node:zlib";
import { ImportReadError } from "./types.js";

/**
 * A streaming zip reader with no size cap. Takeout and Spotify exports are multi-gigabyte zips, so nothing here
 * loads a whole archive: the central directory is read from the end of the file (ZIP64 included), and an entry is
 * streamed straight from its offset through inflate, with its CRC-32 and size checked as the last chunk passes.
 * Zero dependencies: `node:fs` and `node:zlib` only.
 */

export interface ZipEntry {
  /** The path inside the archive, with `/` separators. */
  path: string;
  size: number;
  compressedSize: number;
  method: number;
  crc: number;
  flags: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The most central directory read into memory: millions of entries. */
const MAX_DIRECTORY_BYTES = 512 * 1024 * 1024;

function notZip(path: string, detail: string): ImportReadError {
  return new ImportReadError(
    `${path} could not be read as a zip (${detail}). A Takeout or Spotify export that was cut off while downloading looks like this: download it again.`
  );
}

/** Lists the entries of a zip file. Directory entries are left out. */
export async function listZip(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    if (size < 22) throw notZip(path, "the file is smaller than a zip end record");
    const tailLength = Math.min(size, 65_557 + 22);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd === -1) throw notZip(path, "no end-of-archive record found");
    let entryCount = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = eocd - 20;
      if (locator < 0 || tail.readUInt32LE(locator) !== EOCD64_LOCATOR)
        throw notZip(path, "ZIP64 fields are set but the ZIP64 locator is missing");
      const recordOffset = Number(tail.readBigUInt64LE(locator + 8));
      const record = Buffer.alloc(56);
      await handle.read(record, 0, 56, recordOffset);
      if (record.readUInt32LE(0) !== EOCD64) throw notZip(path, "the ZIP64 end record is missing");
      entryCount = Number(record.readBigUInt64LE(32));
      directorySize = Number(record.readBigUInt64LE(40));
      directoryOffset = Number(record.readBigUInt64LE(48));
    }
    if (directorySize > MAX_DIRECTORY_BYTES) throw notZip(path, "the directory is implausibly large");
    if (directoryOffset + directorySize > size) throw notZip(path, "the directory lies past the end of the file");
    const directory = Buffer.alloc(directorySize);
    let filled = 0;
    while (filled < directorySize) {
      const { bytesRead } = await handle.read(directory, filled, directorySize - filled, directoryOffset + filled);
      if (bytesRead === 0) throw notZip(path, "the directory is cut short");
      filled += bytesRead;
    }
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let n = 0; n < entryCount; n += 1) {
      if (at + 46 > directory.length || directory.readUInt32LE(at) !== CENTRAL)
        throw notZip(path, `directory entry ${n} is damaged`);
      const flags = directory.readUInt16LE(at + 8);
      const method = directory.readUInt16LE(at + 10);
      const crc = directory.readUInt32LE(at + 16);
      let compressedSize = directory.readUInt32LE(at + 20);
      let uncompressedSize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      let localOffset = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength).replaceAll("\\", "/");
      const extraStart = at + 46 + nameLength;
      const extraEnd = extraStart + extraLength;
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
        for (let e = extraStart; e + 4 <= extraEnd;) {
          const id = directory.readUInt16LE(e);
          const length = directory.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let p = e + 4;
            if (uncompressedSize === 0xffffffff) {
              uncompressedSize = Number(directory.readBigUInt64LE(p));
              p += 8;
            }
            if (compressedSize === 0xffffffff) {
              compressedSize = Number(directory.readBigUInt64LE(p));
              p += 8;
            }
            if (localOffset === 0xffffffff) localOffset = Number(directory.readBigUInt64LE(p));
            break;
          }
          e += 4 + length;
        }
      }
      at = extraEnd + commentLength;
      if (name.endsWith("/")) continue;
      entries.push({ path: name, size: uncompressedSize, compressedSize, method, crc, flags, localOffset });
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/** Streams one entry's uncompressed bytes. Throws `ImportReadError` for encryption, an unknown method or a CRC or size mismatch. */
export async function* readZipEntry(zipPath: string, entry: ZipEntry): AsyncGenerator<Buffer> {
  if (entry.flags & 0x1)
    throw new ImportReadError(`${entry.path} in ${zipPath} is password-protected; unzip it with the password first.`);
  if (entry.method !== 0 && entry.method !== 8)
    throw new ImportReadError(
      `${entry.path} in ${zipPath} uses compression method ${entry.method}, which is not supported. Unzip it with your usual tool and point the command at the folder.`
    );
  const handle = await open(zipPath, "r");
  let dataStart: number;
  try {
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.localOffset);
    if (header.readUInt32LE(0) !== LOCAL) throw notZip(zipPath, `the header of ${entry.path} is damaged`);
    dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  if (entry.compressedSize === 0) {
    if (entry.size === 0) return;
    throw notZip(zipPath, `${entry.path} has no data`);
  }
  const raw = createReadStream(zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  const stream = entry.method === 8 ? createInflateRaw() : null;
  const source = stream ?? raw;
  if (stream) pipeline(raw, stream, () => undefined);
  let crc = 0;
  let length = 0;
  try {
    for await (const chunk of source as AsyncIterable<Buffer>) {
      crc = crc32(chunk, crc);
      length += chunk.length;
      if (length > entry.size)
        throw notZip(zipPath, `${entry.path} inflates past its declared size of ${entry.size} bytes`);
      yield chunk;
    }
  } finally {
    raw.destroy();
    stream?.destroy();
  }
  if (length !== entry.size) throw notZip(zipPath, `${entry.path} has ${length} bytes, expected ${entry.size}`);
  if (crc >>> 0 !== entry.crc) throw notZip(zipPath, `${entry.path} fails its checksum`);
}
