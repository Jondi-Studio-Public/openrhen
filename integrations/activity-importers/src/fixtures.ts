import { crc32, deflateRawSync } from "node:zlib";

/** Helpers for tests: synthetic inputs only, no real exports. */

/** A byte source that hands `text` over `size` characters at a time, so chunk-boundary bugs show up. */
export async function* chunked(text: string, size = 7): AsyncGenerator<Buffer> {
  const bytes = Buffer.from(text, "utf8");
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export interface FixtureFile {
  name: string;
  data: string | Buffer;
  /** `store` writes the bytes as they are; the default compresses. */
  method?: "store" | "deflate";
  /** Corrupts the stored checksum. */
  badCrc?: boolean;
}

/** Writes a zip. `zip64` puts sizes and offsets in ZIP64 extra fields and ends with a ZIP64 end record. */
export function makeZip(files: FixtureFile[], options: { zip64?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, "utf8");
    const method = file.method === "store" ? 0 : 8;
    const body = method === 0 ? raw : deflateRawSync(raw);
    const name = Buffer.from(file.name, "utf8");
    const crc = file.badCrc ? (crc32(raw) ^ 0xffff) >>> 0 : crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(45, 4);
    entry.writeUInt16LE(45, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt16LE(name.length, 28);
    let extra = Buffer.alloc(0);
    if (options.zip64) {
      entry.writeUInt32LE(0xffffffff, 20);
      entry.writeUInt32LE(0xffffffff, 24);
      entry.writeUInt32LE(0xffffffff, 42);
      extra = Buffer.alloc(28);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(24, 2);
      extra.writeBigUInt64LE(BigInt(raw.length), 4);
      extra.writeBigUInt64LE(BigInt(body.length), 12);
      extra.writeBigUInt64LE(BigInt(offset), 20);
      entry.writeUInt16LE(extra.length, 30);
    } else {
      entry.writeUInt32LE(body.length, 20);
      entry.writeUInt32LE(raw.length, 24);
      entry.writeUInt32LE(offset, 42);
    }
    central.push(entry, name, extra);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  if (options.zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(files.length), 24);
    record.writeBigUInt64LE(BigInt(files.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
    return Buffer.concat([...parts, directory, record, locator, end]);
  }
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
