import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serverCommit, withServerCommit } from "./build-commit";
import { COMMIT_SENTINEL, loadCliBundle } from "./cli-bundle";

const BUNDLE = `#!/usr/bin/env node\nconst commit = ${COMMIT_SENTINEL};\nconst again = ${COMMIT_SENTINEL};\n`;
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-bundle-"));
  path = join(dir, "rhen.mjs");
  writeFileSync(path, BUNDLE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("serverCommit", () => {
  it("reads the build commit and treats dev, empty and unknown as unknown", () => {
    expect(serverCommit({ OPENRHEN_BUILD_COMMIT: "c9d81b2aaaaa" })).toBe("c9d81b2aaaaa");
    for (const value of ["dev", "", "  ", "unknown", undefined])
      expect(serverCommit({ OPENRHEN_BUILD_COMMIT: value })).toBeNull();
  });
});

describe("withServerCommit", () => {
  it("sets the header when known, leaves the response alone when not", () => {
    expect(withServerCommit(new Response("x"), "abc").headers.get("x-openrhen-server-commit")).toBe("abc");
    expect(withServerCommit(new Response("x"), null).headers.has("x-openrhen-server-commit")).toBe(false);
  });

  it("copes with immutable headers", () => {
    const immutable = Response.redirect("http://x/y", 302);
    expect(withServerCommit(immutable, "abc").headers.get("x-openrhen-server-commit")).toBe("abc");
  });
});

describe("loadCliBundle", () => {
  it("stamps every sentinel with the literal commit and hashes the stamped bytes", async () => {
    const bundle = await loadCliBundle({ OPENRHEN_CLI_BUNDLE_PATH: path }, "c9d81b2aaaaa");
    expect(bundle?.text).toBe(BUNDLE.split(COMMIT_SENTINEL).join('"c9d81b2aaaaa"'));
    expect(bundle?.text).not.toContain("__SERVER_COMMIT__");
    expect(bundle?.sha256).toBe(
      createHash("sha256")
        .update(bundle?.text ?? "")
        .digest("hex")
    );
    expect(bundle?.bytes).toBe(Buffer.byteLength(bundle?.text ?? ""));
  });

  it("serves the bundle unstamped when the commit is unknown", async () => {
    const bundle = await loadCliBundle({ OPENRHEN_CLI_BUNDLE_PATH: path }, null);
    expect(bundle?.text).toBe(BUNDLE);
  });

  it("returns null when the file is missing", async () => {
    expect(await loadCliBundle({ OPENRHEN_CLI_BUNDLE_PATH: join(dir, "nope.mjs") }, "abc")).toBeNull();
  });
});
