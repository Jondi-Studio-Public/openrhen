import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BACKUP_FILENAME, latestValidBackup, writeFileAtomic } from "./backup-files.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "backup-files-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
  it("leaves only the final file, no .partial", async () => {
    const path = join(dir, "priorities-a.json");
    await writeFileAtomic(path, "{}\n");
    expect(await readdir(dir)).toEqual(["priorities-a.json"]);
  });

  it("cleans up the partial file when the rename fails", async () => {
    // The target is a non-empty directory, so the rename cannot succeed.
    const path = join(dir, "priorities-b.json");
    await mkdir(path);
    await writeFile(join(path, "x"), "x");
    await expect(writeFileAtomic(path, "{}")).rejects.toThrow();
    expect(await readdir(dir)).toEqual(["priorities-b.json"]);
  });
});

describe("latestValidBackup", () => {
  const load = (text: string) => JSON.parse(text) as { ok: number };

  it("skips a truncated newest file and a .partial file, falling back to the previous backup", async () => {
    await writeFile(join(dir, "priorities-2026-01-01.json"), '{"ok":1}');
    await writeFile(join(dir, "priorities-2026-01-02.json"), '{"ok":');
    await writeFile(join(dir, "priorities-2026-01-03.json.partial"), '{"ok":3}');
    const found = await latestValidBackup(dir, load);
    expect(found.backup).toEqual({ ok: 1 });
    expect(found.path.endsWith("priorities-2026-01-01.json")).toBe(true);
    expect(found.skipped).toHaveLength(1);
    expect(found.skipped[0]).toContain("priorities-2026-01-02.json");
  });

  it("names the rejected files when none is valid, and reports an empty directory", async () => {
    await expect(latestValidBackup(dir, load)).rejects.toThrow("No OpenRhen backup found");
    await writeFile(join(dir, "priorities-x.json"), "nope");
    await expect(latestValidBackup(dir, load)).rejects.toThrow(/rejected priorities-x\.json/);
  });
});

describe("BACKUP_FILENAME", () => {
  it("matches both the OpenRhen and the OpenRhen prefix, and never a partial file", () => {
    expect(BACKUP_FILENAME.test("priorities-2026-01-01T00-00-00-000Z.json")).toBe(true);
    expect(BACKUP_FILENAME.test("openrhen-2026-01-01T00-00-00-000Z.json")).toBe(true);
    expect(BACKUP_FILENAME.test("openrhen-2026-01-01.json.partial")).toBe(false);
    expect(BACKUP_FILENAME.test("other-2026-01-01.json")).toBe(false);
  });
});
