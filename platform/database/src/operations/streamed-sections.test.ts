import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSection,
  sectionFileName,
  verifySection,
  writeSection,
  type SectionReadback,
  type StreamedSection
} from "./streamed-sections.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "section-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function* batches(...groups: Record<string, unknown>[][]) {
  for (const group of groups) yield group;
}
const collect = async (path: string, batchRows?: number) => {
  const readback: SectionReadback = { rows: 0, bytes: 0, sha256: "" };
  const out: Record<string, unknown>[][] = [];
  for await (const batch of readSection(path, readback, batchRows)) out.push(batch);
  return { out, readback };
};

describe("sectionFileName", () => {
  it("sits beside the JSON backup and names the table", () => {
    expect(sectionFileName("priorities-2026-11-07T10-00-00-000Z.json", "activity_events")).toBe(
      "priorities-2026-11-07T10-00-00-000Z.activity-events.ndjson"
    );
  });
});

describe("a streamed section", () => {
  const rows = [
    { id: "a", n: 1, at: "2026-11-07T10:00:00.000Z", text: "naïve — 日本語 😀", attrs: { b: 1, a: [1, 2] } },
    { id: "b", n: 2, at: null, text: 'quote " and \\ and \nnewline', attrs: {} },
    { id: "c", n: 3, at: null, text: null, attrs: {} }
  ];

  it("round-trips rows exactly, in order, in batches of the requested size", async () => {
    const path = join(dir, "s.ndjson");
    const written = await writeSection(path, batches([rows[0]!], [], [rows[1]!, rows[2]!]));
    expect(written).toMatchObject({ rows: 3 });
    const { out, readback } = await collect(path, 2);
    expect(out.map((batch) => batch.length)).toEqual([2, 1]);
    expect(out.flat()).toEqual(rows);
    expect(readback).toEqual(written);
    await expect(verifySection(path, { file: "s.ndjson", ...written })).resolves.toBeUndefined();
  });

  it("writes an empty table as an empty file that verifies", async () => {
    const path = join(dir, "e.ndjson");
    const written = await writeSection(path, batches());
    expect(written.rows).toBe(0);
    expect(written.bytes).toBe(0);
    await expect(verifySection(path, { file: "e.ndjson", ...written })).resolves.toBeUndefined();
  });

  it("is atomic: no .partial is left on success, and none on a failure mid-stream", async () => {
    const path = join(dir, "f.ndjson");
    await writeSection(path, batches(rows));
    expect(await readdir(dir)).toEqual(["f.ndjson"]);
    async function* failing() {
      yield [rows[0]!];
      throw new Error("cursor died");
    }
    await expect(writeSection(join(dir, "g.ndjson"), failing())).rejects.toThrow("cursor died");
    expect(await readdir(dir)).toEqual(["f.ndjson"]);
  });

  it("refuses to overwrite an existing partial, so two writers never interleave", async () => {
    await writeFile(join(dir, "h.ndjson.partial"), "x");
    await expect(writeSection(join(dir, "h.ndjson"), batches(rows))).rejects.toThrow();
  });

  describe("verifySection", () => {
    const setup = async () => {
      const path = join(dir, "v.ndjson");
      const written = await writeSection(path, batches(rows));
      const section: StreamedSection = { file: "v.ndjson", ...written };
      return { path, section };
    };

    it("rejects a flipped byte (checksum), keeping the length the same", async () => {
      const { path, section } = await setup();
      const bytes = await readFile(path);
      bytes[10] = bytes[10]! ^ 1;
      await writeFile(path, bytes);
      await expect(verifySection(path, section)).rejects.toThrow(/checksum does not match|not valid JSON/);
    });

    it("rejects a truncated file, whether or not the cut is at a line end", async () => {
      const { path, section } = await setup();
      const text = await readFile(path, "utf8");
      await writeFile(path, text.slice(0, text.length - 5));
      await expect(verifySection(path, section)).rejects.toThrow(/truncated/);
      const lines = text.split("\n");
      await writeFile(path, `${lines[0]}\n`);
      await expect(verifySection(path, section)).rejects.toThrow(/bytes but the backup recorded/);
    });

    it("rejects a manifest whose row count or checksum is wrong", async () => {
      const { path, section } = await setup();
      await expect(verifySection(path, { ...section, rows: section.rows + 1 })).rejects.toThrow(
        /holds 3 rows but the backup recorded 4/
      );
      await expect(verifySection(path, { ...section, sha256: "0".repeat(64) })).rejects.toThrow(/checksum/);
    });

    it("rejects a blank line and a non-object line, naming the line", async () => {
      const path = join(dir, "b.ndjson");
      await writeFile(path, '{"a":1}\n\n{"a":2}\n');
      await expect(collect(path)).rejects.toThrow(/line 2 is not valid JSON/);
      await writeFile(path, '{"a":1}\n[1]\n');
      await expect(collect(path)).rejects.toThrow(/line 2 is not a row object/);
    });

    it("reports a missing file as ENOENT", async () => {
      const { section } = await setup();
      await expect(verifySection(join(dir, "nope.ndjson"), section)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reads multi-byte text split across chunk boundaries (small reads)", async () => {
    const path = join(dir, "m.ndjson");
    const many = Array.from({ length: 5000 }, (_, i) => ({ id: i, text: "日本語😀".repeat(20) }));
    const written = await writeSection(path, batches(many));
    const { out } = await collect(path, 1000);
    expect(out.flat()).toEqual(many);
    expect(out).toHaveLength(5);
    expect(written.bytes).toBeGreaterThan(65536 * 2);
  });
});
