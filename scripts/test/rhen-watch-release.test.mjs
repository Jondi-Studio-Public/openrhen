import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { cargoVersion, checkTag } from "../ci/rhen-watch-version.mjs";

const root = resolve(import.meta.dirname, "../..");
const cargo = '[package]\nname = "rhen-watch"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1.0.229" }\n';

test("cargoVersion reads the package version, not a dependency's", () => {
  assert.equal(cargoVersion(cargo), "0.1.0");
  assert.equal(cargoVersion('[dependencies]\nx = { version = "9.9.9" }\nversion = "9.9.9"\n'), null);
});

test("the tag must be rhen-watch-v plus the Cargo.toml version", () => {
  assert.deepEqual(checkTag("rhen-watch-v0.1.0", cargo), { version: "0.1.0" });
  for (const bad of ["rhen-watch-v0.1.1", "v0.1.0", "rhen-watch-0.1.0", "rhen-watch-v0.1.0-rc1", "", undefined])
    assert.ok(checkTag(bad, cargo).error, `${bad} should be refused`);
  assert.ok(checkTag("rhen-watch-v0.1", '[package]\nversion = "0.1"\n').error, "non-semver crate version");
});

test("the real Cargo.toml has a version the gate accepts", () => {
  const text = readFileSync(resolve(root, "tools/rhen-watch/Cargo.toml"), "utf8");
  const version = cargoVersion(text);
  assert.ok(version);
  assert.deepEqual(checkTag(`rhen-watch-v${version}`, text), { version });
});

test("the CLI prints the version for a matching tag and fails otherwise", () => {
  const run = (tag) =>
    spawnSync(process.execPath, [resolve(root, "scripts/ci/rhen-watch-version.mjs")], {
      env: { ...process.env, TAG: tag },
      encoding: "utf8"
    });
  const version = cargoVersion(readFileSync(resolve(root, "tools/rhen-watch/Cargo.toml"), "utf8"));
  const ok = run(`rhen-watch-v${version}`);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), version);
  assert.equal(run("rhen-watch-v999.0.0").status, 1);
});

const ps1 = readFileSync(resolve(root, "scripts/install/rhen-watch.ps1"), "utf8");

test("install.ps1 has exactly one version placeholder and the safety rules", () => {
  assert.equal(ps1.split("@VERSION@").length - 1, 2, "one in the header comment, one assignment");
  assert.match(ps1, /\$version = '@VERSION@'/);
  assert.match(ps1, /\$ErrorActionPreference = 'Stop'/);
  assert.match(ps1, /https:\/\/github\.com\/Jondi-Studio-Public\/openrhen\/releases\/download\//);
  assert.doesNotMatch(ps1, /http:\/\//);
  assert.match(ps1, /Get-FileHash/);
  assert.match(ps1, /checksum mismatch/);
  assert.doesNotMatch(ps1, /^\s*exit\b/m, "an exit would close the shell of `irm | iex`");
});

test("the stamped install.ps1 parses (when pwsh is installed)", (t) => {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" });
  if (probe.error) return t.skip("pwsh is not installed here; CI runs this where it is");
  const stamped = ps1.replaceAll("@VERSION@", "0.1.0").replaceAll("'", "''");
  const cmd = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput('${stamped}', [ref]$null, [ref]$e); if ($e.Count) { $e | Out-String; exit 1 }`;
  const out = spawnSync("pwsh", ["-NoProfile", "-Command", cmd], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});

test("the release workflow keeps write access on publish only", () => {
  const wf = readFileSync(resolve(root, ".github/workflows/rhen-watch-release.yml"), "utf8");
  assert.match(wf, /^permissions:\n {2}contents: read\n/m);
  assert.equal(wf.match(/contents: write/g).length, 1);
  assert.ok(wf.indexOf("contents: write") > wf.indexOf("  publish:"));
  assert.match(wf, /tags: \["rhen-watch-v\*"\]/);
});
