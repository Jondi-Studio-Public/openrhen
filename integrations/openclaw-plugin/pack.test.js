import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { pack } from "./pack.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "pack-test-"));
let n = 0;
const dir = () => join(scratch, `d${n++}`);
test.after(() => rmSync(scratch, { recursive: true, force: true }));

/** A copy of the plugin without node_modules and the pack files themselves. */
function copyPlugin() {
  const to = dir();
  cpSync(root, to, { recursive: true, filter: (src) => !src.includes("node_modules") });
  return to;
}

function extract(tgz) {
  const to = dir();
  mkdirSync(to);
  execFileSync("tar", ["-xzf", tgz, "-C", to]);
  return to;
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("two packs are byte-identical, and the sha256 file matches", () => {
  const a = pack({ out: dir() });
  const b = pack({ out: dir() });
  assert.deepEqual(readFileSync(a.tgz), readFileSync(b.tgz));
  assert.equal(a.name, `openrhen-openclaw-plugin-${pkg.version}.tgz`);
  const digest = createHash("sha256").update(readFileSync(a.tgz)).digest("hex");
  assert.equal(readFileSync(a.sha256, "utf8"), `${digest}  ${a.name}\n`);
});

test("the tarball holds the files list and package.json, sorted, under openclaw-plugin/, with fixed metadata", () => {
  const { tgz } = pack({ out: dir() });
  const listing = execFileSync("tar", ["-tzvf", tgz], { encoding: "utf8" }).trim().split("\n");
  const names = listing.map((line) => line.split(/\s+/).at(-1));
  assert.deepEqual(names, [...names].sort());
  for (const name of names) assert.ok(name.startsWith("openclaw-plugin/"), name);
  for (const entry of ["package.json", "openclaw.plugin.json", "index.js", "agent-time.js", "stamp-url.mjs", "README.md"]) {
    assert.ok(names.includes(`openclaw-plugin/${entry}`), entry);
  }
  assert.ok(names.some((name) => name.startsWith("openclaw-plugin/skills/") && name.endsWith("SKILL.md")));
  for (const name of names) assert.doesNotMatch(name, /node_modules|\.test\.|pack\.mjs/);
  for (const line of listing) {
    assert.match(line, /^-rw-r--r-- 0\/0 /);
    assert.match(line, /1970-01-01/);
  }
});

test("only the packed package.json loses private: true", () => {
  const { tgz } = pack({ out: dir() });
  const packed = JSON.parse(readFileSync(join(extract(tgz), "openclaw-plugin/package.json"), "utf8"));
  assert.equal(packed.private, undefined);
  assert.equal(packed.version, pkg.version);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).private, true);
});

test("refuses a manifest that is already stamped", () => {
  const src = copyPlugin();
  execFileSync("node", [join(src, "stamp-url.mjs"), "https://example.com", src]);
  assert.throws(() => pack({ dir: src, out: dir() }), /already stamped/);
});

test("refuses personal strings in a packed file", () => {
  const src = copyPlugin();
  writeFileSync(join(src, "README.md"), `${readFileSync(join(src, "README.md"), "utf8")}\nsee nas.local\n`);
  assert.throws(() => pack({ dir: src, out: dir() }), /personal values found in: openclaw-plugin\/README\.md/);
});

test("the unpacked tree stamps and passes the no-personal-values test", () => {
  const { tgz } = pack({ out: dir() });
  const tree = extract(tgz);
  const plugin = join(tree, "openclaw-plugin");
  execFileSync("node", ["openclaw-plugin/stamp-url.mjs", "https://example.com"], { cwd: tree });
  const manifest = JSON.parse(readFileSync(join(plugin, "openclaw.plugin.json"), "utf8"));
  assert.ok(Object.values(manifest.mcpServers).every((server) => server.url === "https://example.com/mcp"));
  // The packed tree carries no tests; run the personal-values scan from the source against it.
  cpSync(join(root, "no-personal-values.test.js"), join(plugin, "no-personal-values.test.js"));
  execFileSync("node", ["--test", "no-personal-values.test.js"], { cwd: plugin, stdio: "pipe" });
});

test("refuses a word from the OPENRHEN_PACK_DENYLIST environment variable", () => {
  const src = copyPlugin();
  writeFileSync(join(src, "README.md"), `${readFileSync(join(src, "README.md"), "utf8")}\nask zebrafish\n`);
  assert.doesNotThrow(() => pack({ dir: src, out: dir() }));
  process.env.OPENRHEN_PACK_DENYLIST = "zebrafish|other";
  try {
    assert.throws(() => pack({ dir: src, out: dir() }), /personal values found in: openclaw-plugin\/README\.md/);
  } finally {
    delete process.env.OPENRHEN_PACK_DENYLIST;
  }
});
