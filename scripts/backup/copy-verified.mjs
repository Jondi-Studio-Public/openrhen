import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

/** sha256 of a file's bytes, streamed so a large backup is not held in memory. */
export async function fileSha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Copies a backup into `directory` so the final name only ever appears complete and identical:
 * copy to `<name>.partial`, compare the sha256 of both files (a size match proves little), then
 * rename. A kill mid-copy or a corrupt copy leaves nothing matching the backup naming pattern.
 */
export async function copyVerified(source, directory) {
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, basename(source));
  const partial = `${destination}.partial`;
  try {
    await copyFile(source, partial);
    const [expected, actual] = await Promise.all([fileSha256(source), fileSha256(partial)]);
    if (expected !== actual)
      throw new Error("Copy does not match the backup (sha256 differs); the destination is unreliable.");
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return destination;
}
