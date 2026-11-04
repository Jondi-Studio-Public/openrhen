// The plugin ships to other people's installs: it must name no person, host or instance of the maintainer's.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL(".", import.meta.url).pathname;
// Generic network patterns only. The maintainer's private words come from OPENRHEN_PACK_DENYLIST (`|`-separated regex
// words), set in the private repository's CI, so this public file names no one.
const EXTRA = (process.env.OPENRHEN_PACK_DENYLIST ?? "").split("|").map((word) => word.trim()).filter(Boolean);
const FORBIDDEN = new RegExp(["\\.local\\b", "192\\.168", "\\.ts\\.net", "\\btailnet\\b", ...EXTRA].join("|"), "i");
// These files define or exercise the generic patterns, so they name them.
const EXEMPT = ["no-personal-values.test.js", "pack.mjs", "pack.test.js"];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules") return [];
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

test("no file names a person, host or instance of the maintainer's", () => {
  const hits = files(root)
    .filter((path) => !EXEMPT.some((name) => path.endsWith(`/${name}`)))
    .flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .map((line, index) => ({ path, line: index + 1, text: line }))
        .filter(({ text }) => FORBIDDEN.test(text))
    );
  assert.deepEqual(hits.map(({ path, line }) => `${path}:${line}`), []);
});

test("the agent's re-entry rules are in the skills", () => {
  const skills = readFileSync(join(root, "skills/openrhen-catch-up/SKILL.md"), "utf8");
  assert.match(skills, /startFresh/);
  assert.match(skills, /drop_all/);
  assert.match(skills, /Unknown entry id/);
});
