import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { listZip, readZipEntry, type ZipEntry } from "./zip.js";
import { ImportReadError, type ByteSource } from "./types.js";

/**
 * Where an export's files come from: a zip (Takeout, Spotify, Discord, Apple Health), a folder it was unzipped
 * into, a folder of several zip parts (Takeout splits big exports), or one bare file. Callers see a flat list of
 * entries with `/`-separated paths and stream any of them; nothing is extracted to disk.
 */
export interface ArchiveEntry {
  path: string;
  size: number;
}

export interface Archive {
  kind: "zip" | "folder" | "file";
  /** What the user named, for messages. */
  label: string;
  entries: ArchiveEntry[];
  /** Paths that more than one zip part carried; the first copy was kept and the others ignored. */
  duplicates: string[];
  open(path: string): ByteSource;
  /** The path the user named (a file, or the folder). */
  readonly root: string;
}

const ZIP_MAGIC = [Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from([0x50, 0x4b, 0x05, 0x06])];

async function looksLikeZip(path: string): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && ZIP_MAGIC.some((magic) => magic.equals(head));
  } finally {
    await handle.close();
  }
}

async function* walk(directory: string): AsyncGenerator<string> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, item.name);
    if (item.isDirectory()) yield* walk(full);
    else if (item.isFile()) yield full;
  }
}

/** Opens the file or folder the user named. A folder's zip files are read as archives and its other files as they are. */
export async function openArchive(path: string): Promise<Archive> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ImportReadError(`${path} does not exist. Check the path (in PowerShell, quote a path that has spaces).`);
  }
  const readers = new Map<string, () => ByteSource>();
  const entries: ArchiveEntry[] = [];
  const duplicates: string[] = [];
  const addZip = async (zipPath: string, prefix: string) => {
    const zipEntries = await listZip(zipPath);
    for (const entry of zipEntries) addZipEntry(zipPath, entry, prefix);
  };
  const addZipEntry = (zipPath: string, entry: ZipEntry, prefix: string) => {
    const full = prefix + entry.path;
    // Two parts of one Takeout can carry the same path; the first wins and the duplicate is ignored.
    if (readers.has(full)) {
      if (!duplicates.includes(full)) duplicates.push(full);
      return;
    }
    readers.set(full, () => readZipEntry(zipPath, entry));
    entries.push({ path: full, size: entry.size });
  };
  if (info.isDirectory()) {
    for await (const file of walk(path)) {
      const rel = relative(path, file).split(sep).join("/");
      if (file.toLowerCase().endsWith(".zip") && (await looksLikeZip(file))) {
        await addZip(file, "");
        continue;
      }
      const size = (await stat(file)).size;
      readers.set(rel, () => createReadStream(file));
      entries.push({ path: rel, size });
    }
    return { kind: "folder", label: path, entries, duplicates, open: (p) => openEntry(readers, p, path), root: path };
  }
  if (await looksLikeZip(path)) {
    await addZip(path, "");
    return { kind: "zip", label: path, entries, duplicates, open: (p) => openEntry(readers, p, path), root: path };
  }
  // A bare file keeps its folder name, because a My Activity file's product is the folder it sits in.
  const entryPath = `${basename(dirname(path))}/${basename(path)}`;
  readers.set(entryPath, () => createReadStream(path));
  entries.push({ path: entryPath, size: info.size });
  return { kind: "file", label: path, entries, duplicates, open: (p) => openEntry(readers, p, path), root: path };
}

async function* openEntry(readers: Map<string, () => ByteSource>, path: string, label: string): ByteSource {
  const reader = readers.get(path);
  if (!reader) throw new ImportReadError(`${path} is not in ${label}.`);
  yield* reader() as AsyncIterable<Uint8Array>;
}

/** SHA-256 of a file, streamed. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The hash an import is recorded under, memoised for one plan so a zip is read once however many sources it feeds.
 * A bare file or a single zip is the file's own SHA-256. A folder has no single file to hash, so it is the hash of
 * the listing of the entries the import reads (`paths`): each entry's path, size and content hash, in code-unit
 * path order; each entry is hashed once. A folder of zip parts is hashed that way too.
 */
export function archiveHasher(archive: Archive): (paths: readonly string[]) => Promise<string> {
  let whole: Promise<string> | undefined;
  const parts = new Map<string, Promise<string>>();
  const entryHash = (path: string) => {
    let held = parts.get(path);
    if (!held) {
      held = (async () => {
        const part = createHash("sha256");
        for await (const chunk of archive.open(path)) part.update(chunk);
        return part.digest("hex");
      })();
      parts.set(path, held);
    }
    return held;
  };
  return (paths) => {
    if (archive.kind !== "folder") return (whole ??= sha256File(archive.root));
    return (async () => {
      const hash = createHash("sha256");
      const wanted = new Set(paths);
      for (const entry of archive.entries
        .filter((candidate) => wanted.has(candidate.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
        hash.update(`${entry.path}\0${entry.size}\0${await entryHash(entry.path)}\n`);
      return hash.digest("hex");
    })();
  };
}

export function archiveSha256(archive: Archive, paths: readonly string[]): Promise<string> {
  return archiveHasher(archive)(paths);
}

/** A hash for one source taken out of a container: the container's hash and the source name, so two sources of one zip are two imports. */
export function sourceSha256(containerSha256: string, source: string): string {
  return createHash("sha256").update(`${containerSha256}\n${source}`).digest("hex");
}
