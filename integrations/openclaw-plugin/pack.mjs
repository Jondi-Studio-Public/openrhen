#!/usr/bin/env node
// Packs this plugin into a deterministic release tarball: node pack.mjs [--out <dir>] [--dir <plugin-dir>]
// Writes openrhen-openclaw-plugin-<version>.tgz and a .sha256 beside it. Same inputs give the same bytes:
// entries are sorted, mtime is 0, owner is 0/0, the gzip header carries no time or operating system.
// The package sits inside the tarball under openclaw-plugin/, ready for `node openclaw-plugin/stamp-url.mjs`.
// Dependency-free. It refuses to pack a stamped manifest or one that names a maintainer's person or host.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { isStamped } from "./stamp-url.mjs";

export const TARBALL_PREFIX = "openrhen-openclaw-plugin";
const FOLDER = "openclaw-plugin";
// Generic patterns only: addresses that identify a private network. Words that identify a person or an instance are the
// maintainer's own and live outside this public file: set OPENRHEN_PACK_DENYLIST to a `|`-separated list of regex words.
export function personalPattern(env = process.env) {
  const extra = (env.OPENRHEN_PACK_DENYLIST ?? "")
    .split("|")
    .map((word) => word.trim())
    .filter(Boolean);
  return new RegExp(["\\.local\\b", "192\\.168", "\\.ts\\.net", "\\btailnet\\b", ...extra].join("|"), "i");
}

function walk(dir, rel = "") {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = rel ? `${rel}/${name}` : name;
    return statSync(join(dir, path)).isDirectory() ? walk(dir, path) : [path];
  });
}

/** The files to pack: package.json plus each `files` entry (a folder expands to its files), sorted by byte order. */
export function listFiles(dir, pkg) {
  const out = new Set(["package.json"]);
  for (const entry of pkg.files ?? []) {
    const stat = statSync(join(dir, entry));
    for (const path of stat.isDirectory() ? walk(dir, entry) : [entry]) out.add(path);
  }
  return [...out].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
}

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function header(name, size) {
  if (Buffer.byteLength(name) > 100) throw new Error(`path too long for the tar header: ${name}`);
  const block = Buffer.alloc(512);
  block.write(name, 0, "utf8");
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108); // uid
  block.write(octal(0, 8), 116); // gid
  block.write(octal(size, 12), 124);
  block.write(octal(0, 12), 136); // mtime
  block.write("        ", 148); // checksum placeholder
  block.write("0", 156); // regular file
  block.write("ustar\0", 257);
  block.write("00", 263);
  const sum = [...block].reduce((a, b) => a + b, 0);
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function tar(entries) {
  const parts = [];
  for (const { name, data } of entries) {
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/** Packs the plugin in `dir` into `out`; returns { tgz, sha256, name }. Throws when the plugin must not ship. */
export function pack({ dir = fileURLToPath(new URL(".", import.meta.url)), out = process.cwd() } = {}) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(join(dir, "openclaw.plugin.json"), "utf8"));
  if (isStamped(manifest)) {
    throw new Error("openclaw.plugin.json is already stamped with a server address; pack the unstamped plugin");
  }
  if (!pkg.version) throw new Error("package.json has no version");
  const { private: _private, ...shipped } = pkg;
  const entries = listFiles(dir, pkg).map((path) => ({
    name: `${FOLDER}/${path}`,
    data: path === "package.json" ? Buffer.from(`${JSON.stringify(shipped, null, 2)}\n`) : readFileSync(join(dir, path))
  }));
  const hits = entries.filter(({ data }) => personalPattern().test(data.toString("utf8"))).map(({ name }) => name);
  if (hits.length) throw new Error(`personal values found in: ${hits.join(", ")}`);
  const gz = gzipSync(tar(entries), { level: 9 });
  gz[9] = 255; // the operating-system byte of the gzip header: unknown, so every platform writes the same bytes
  const name = `${TARBALL_PREFIX}-${pkg.version}.tgz`;
  const sha256 = createHash("sha256").update(gz).digest("hex");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, name), gz);
  writeFileSync(join(out, `${name}.sha256`), `${sha256}  ${name}\n`);
  return { tgz: join(out, name), sha256: join(out, `${name}.sha256`), name };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  try {
    const result = pack({
      dir: option("--dir") ? resolve(option("--dir")) : undefined,
      out: resolve(option("--out") ?? ".")
    });
    console.log(`Packed ${result.tgz}\nWrote ${result.sha256}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
