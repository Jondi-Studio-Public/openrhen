import type JSZip from "jszip";

export const MAX_ZIP_ENTRIES = 2000;
export const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024;

type ZipEntry = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number };
  internalStream(type: "uint8array"): {
    on(event: "data", cb: (chunk: Uint8Array) => void): ZipStream;
    on(event: "error", cb: (error: Error) => void): ZipStream;
    on(event: "end", cb: () => void): ZipStream;
    pause(): void;
    resume(): void;
  };
};
type ZipStream = ReturnType<ZipEntry["internalStream"]>;

/** A zip's central directory is attacker-controlled, so an archive can name a million entries or inflate a few KB into gigabytes. */
export function assertZipEntryCount(zip: JSZip, label: string) {
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) throw new Error(`${label} has too many entries.`);
}

/**
 * Reads one entry but stops inflating the moment it passes `maxBytes`. The declared size is checked
 * first as a cheap rejection, yet it can lie, so the bytes actually produced are counted too.
 */
export async function readZipEntryCapped(
  entry: JSZip.JSZipObject,
  maxBytes: number,
  label = "Archive entry"
): Promise<Uint8Array> {
  const declared = (entry as ZipEntry)._data?.uncompressedSize;
  if (typeof declared === "number" && declared > maxBytes) throw new Error(`${label} is too large once unpacked.`);
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    const stream = (entry as ZipEntry).internalStream("uint8array");
    stream
      .on("data", (chunk: Uint8Array) => {
        total += chunk.byteLength;
        if (total > maxBytes) {
          stream.pause();
          reject(new Error(`${label} is too large once unpacked.`));
          return;
        }
        chunks.push(chunk);
      })
      .on("error", reject)
      .on("end", () => {
        const out = new Uint8Array(total);
        let at = 0;
        for (const chunk of chunks) {
          out.set(chunk, at);
          at += chunk.byteLength;
        }
        resolve(out);
      })
      .resume();
  });
}
