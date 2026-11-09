// The release gate for rhen-watch: the tag a release is cut from must be `rhen-watch-v` plus the version in
// tools/rhen-watch/Cargo.toml, so an asset name can never disagree with the binary inside it.
// Usage (CI): TAG=rhen-watch-v0.1.0 node scripts/ci/rhen-watch-version.mjs   -> prints the version, or exits 1.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TAG_PREFIX = "rhen-watch-v";

/** The `version` of the `[package]` table in a Cargo.toml text, or null. */
export function cargoVersion(text) {
  let inPackage = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inPackage = line === "[package]";
    else if (inPackage) {
      const m = line.match(/^version\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
      if (m) return m[1];
    }
  }
  return null;
}

/** `{ version }` when the tag matches the crate, else `{ error }`. */
export function checkTag(tag, cargoText) {
  const version = cargoVersion(cargoText);
  if (!version) return { error: "no version in the [package] table of tools/rhen-watch/Cargo.toml" };
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    return { error: `Cargo.toml version "${version}" is not semver` };
  if (typeof tag !== "string" || !tag.startsWith(TAG_PREFIX))
    return { error: `tag "${tag}" must start with ${TAG_PREFIX}` };
  if (tag !== `${TAG_PREFIX}${version}`)
    return { error: `tag "${tag}" does not match Cargo.toml version ${version} (expected ${TAG_PREFIX}${version})` };
  return { version };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const cargo = readFileSync(resolve(import.meta.dirname, "../../tools/rhen-watch/Cargo.toml"), "utf8");
  const result = checkTag(process.env.TAG ?? "", cargo);
  if (result.error) {
    console.error(`::error::${result.error}`);
    process.exit(1);
  }
  console.log(result.version);
}
