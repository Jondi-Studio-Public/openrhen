import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { archiveHasher, archiveSha256, openArchive, sha256File, sourceSha256, type Archive } from "./archive.js";
import { collect, makeZip } from "./fixtures.js";
import { ImportReadError } from "./types.js";
import { listZip, readZipEntry } from "./zip.js";

const dir = mkdtempSync(join(tmpdir(), "activity-zip-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const text = async (chunks: AsyncIterable<Uint8Array | string>) =>
  (await collect(chunks)).map((c) => Buffer.from(c).toString("utf8")).join("");
const big = "line of synthetic text\n".repeat(20_000);

describe("the streaming zip reader", () => {
  it.each([false, true])("lists and streams stored and deflated entries (zip64: %s)", async (zip64) => {
    const path = join(dir, `a-${zip64}.zip`);
    writeFileSync(
      path,
      makeZip(
        [
          { name: "Takeout/Chrome/BrowserHistory.json", data: big },
          { name: "Takeout/readme.txt", data: "stored é", method: "store" },
          { name: "Takeout/empty.txt", data: "", method: "store" }
        ],
        { zip64 }
      )
    );
    const entries = await listZip(path);
    expect(entries.map((e) => e.path)).toEqual([
      "Takeout/Chrome/BrowserHistory.json",
      "Takeout/readme.txt",
      "Takeout/empty.txt"
    ]);
    expect(entries[0]!.size).toBe(big.length);
    expect(await text(readZipEntry(path, entries[0]!))).toBe(big);
    expect(await text(readZipEntry(path, entries[1]!))).toBe("stored é");
    expect(await text(readZipEntry(path, entries[2]!))).toBe("");
  });

  it("rejects an entry whose checksum does not match, after streaming it", async () => {
    const path = join(dir, "bad-crc.zip");
    writeFileSync(path, makeZip([{ name: "x.json", data: "[1,2,3]", badCrc: true }]));
    const [entry] = await listZip(path);
    await expect(collect(readZipEntry(path, entry!))).rejects.toThrow(/fails its checksum/);
  });

  it("stops as soon as an entry inflates past its declared size", async () => {
    const path = join(dir, "bomb.zip");
    writeFileSync(path, makeZip([{ name: "x.txt", data: "a".repeat(1_000_000) }]));
    const [entry] = await listZip(path);
    let read = 0;
    await expect(
      (async () => {
        for await (const chunk of readZipEntry(path, { ...entry!, size: 1000 })) read += chunk.length;
      })()
    ).rejects.toThrow(/inflates past its declared size/);
    expect(read).toBe(0);
  });

  it("explains a file that is not a zip, or was cut off", async () => {
    const whole = makeZip([{ name: "x.json", data: big }]);
    const cut = join(dir, "cut.zip");
    writeFileSync(cut, whole.subarray(0, whole.length - 40));
    await expect(listZip(cut)).rejects.toThrow(ImportReadError);
    await expect(listZip(cut)).rejects.toThrow(/download it again/);
    const tiny = join(dir, "tiny.zip");
    writeFileSync(tiny, "nope");
    await expect(listZip(tiny)).rejects.toThrow(/smaller than a zip end record/);
  });

  it("refuses an unsupported method and an encrypted entry with a plain message", async () => {
    const path = join(dir, "m.zip");
    writeFileSync(path, makeZip([{ name: "x", data: "abc", method: "store" }]));
    const [entry] = await listZip(path);
    await expect(collect(readZipEntry(path, { ...entry!, method: 12 }))).rejects.toThrow(/compression method 12/);
    await expect(collect(readZipEntry(path, { ...entry!, flags: 1 }))).rejects.toThrow(/password-protected/);
  });
});

describe("archiveHasher", () => {
  it("hashes each folder entry once however many sources ask, and a zip once", async () => {
    const opened: string[] = [];
    const fake: Archive = {
      kind: "folder",
      label: "x",
      root: "x",
      duplicates: [],
      entries: [
        { path: "a.json", size: 1 },
        { path: "b.json", size: 1 }
      ],
      open: (path) => {
        opened.push(path);
        return (async function* () {
          yield Buffer.from(path);
        })();
      }
    };
    const hash = archiveHasher(fake);
    const first = await hash(["a.json", "b.json"]);
    expect(await hash(["a.json"])).not.toBe(first);
    await hash(["b.json", "a.json"]);
    expect(opened.sort()).toEqual(["a.json", "b.json"]);
    const zipPath = join(dir, "memo.zip");
    writeFileSync(zipPath, makeZip([{ name: "a.json", data: "[]" }]));
    const zip = await openArchive(zipPath);
    const zipHash = archiveHasher(zip);
    expect(zipHash(["a.json"])).toBe(zipHash(["a.json"]));
  });

  it("lists paths that two zip parts both carry, keeping the first", async () => {
    const folder = join(dir, "dups");
    mkdirSync(folder);
    writeFileSync(
      join(folder, "p1.zip"),
      makeZip([
        { name: "T/a.json", data: "[1]" },
        { name: "T/b.json", data: "[]" }
      ])
    );
    writeFileSync(join(folder, "p2.zip"), makeZip([{ name: "T/a.json", data: "[2]" }]));
    const archive = await openArchive(folder);
    expect(archive.duplicates).toEqual(["T/a.json"]);
    expect(archive.entries).toHaveLength(2);
  });
});

describe("openArchive", () => {
  it("reads a zip, a folder, a folder of zip parts and a bare file as one list of entries", async () => {
    const zipPath = join(dir, "t.zip");
    writeFileSync(zipPath, makeZip([{ name: "Takeout/Chrome/BrowserHistory.json", data: "[]" }]));
    const zip = await openArchive(zipPath);
    expect(zip.kind).toBe("zip");
    expect(zip.entries.map((e) => e.path)).toEqual(["Takeout/Chrome/BrowserHistory.json"]);
    expect(await text(zip.open("Takeout/Chrome/BrowserHistory.json"))).toBe("[]");

    const folder = join(dir, "folder");
    mkdirSync(join(folder, "Takeout", "Maps"), { recursive: true });
    writeFileSync(join(folder, "Takeout", "Maps", "Saved Places.json"), "{}");
    writeFileSync(join(folder, "part-002.zip"), makeZip([{ name: "Takeout/Chrome/BrowserHistory.json", data: "[]" }]));
    writeFileSync(join(folder, "part-001.zip"), makeZip([{ name: "Takeout/Chrome/BrowserHistory.json", data: "[1]" }]));
    const opened = await openArchive(folder);
    expect(opened.kind).toBe("folder");
    expect(opened.entries.map((e) => e.path).sort()).toEqual([
      "Takeout/Chrome/BrowserHistory.json",
      "Takeout/Maps/Saved Places.json"
    ]);

    const bare = await openArchive(join(folder, "Takeout", "Maps", "Saved Places.json"));
    expect(bare.kind).toBe("file");
    expect(bare.entries.map((e) => e.path)).toEqual(["Maps/Saved Places.json"]);
  });

  it("names a path that does not exist", async () => {
    await expect(openArchive(join(dir, "missing.zip"))).rejects.toThrow(/does not exist/);
  });

  it("hashes a file by its own SHA-256 and a folder by the listing of the entries it reads", async () => {
    const zipPath = join(dir, "h.zip");
    writeFileSync(zipPath, makeZip([{ name: "a.json", data: "[]" }]));
    const zip = await openArchive(zipPath);
    expect(await archiveSha256(zip, ["a.json"])).toBe(await sha256File(zipPath));
    const folder = join(dir, "hashed");
    mkdirSync(folder);
    writeFileSync(join(folder, "a.json"), "[]");
    writeFileSync(join(folder, "unrelated.bin"), "x");
    const opened = await openArchive(folder);
    const first = await archiveSha256(opened, ["a.json"]);
    writeFileSync(join(folder, "unrelated.bin"), "changed");
    expect(await archiveSha256(await openArchive(folder), ["a.json"])).toBe(first);
    writeFileSync(join(folder, "a.json"), "[1]");
    expect(await archiveSha256(await openArchive(folder), ["a.json"])).not.toBe(first);
    // Sorting is by code unit, so the hash does not depend on the machine's locale.
    const names = mkdtempSync(join(tmpdir(), "activity-sort-"));
    writeFileSync(join(names, "B.json"), "1");
    writeFileSync(join(names, "a.json"), "2");
    const sorted = await openArchive(names);
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256");
    for (const [n, c] of [
      ["B.json", "1"],
      ["a.json", "2"]
    ] as const)
      expected.update(`${n}\0${c.length}\0${createHash("sha256").update(c).digest("hex")}\n`);
    expect(await archiveSha256(sorted, ["a.json", "B.json"])).toBe(expected.digest("hex"));
    rmSync(names, { recursive: true, force: true });
    expect(sourceSha256("ab", "spotify")).not.toBe(sourceSha256("ab", "fit"));
    expect(sourceSha256("ab", "spotify")).toMatch(/^[0-9a-f]{64}$/);
  });
});
