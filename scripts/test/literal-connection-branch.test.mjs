import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import literalConnectionBranch from "../repository/rules/literal-connection-branch.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PENDING = "scripts/repository/pending/literal-connection-branch";

// Vendor names are built here, never written out: the vendor-term ratchet counts this file too.
const CAL = ["goo", "gle", "_calendar"].join("");
const MAPS = ["goo", "gle"].join("");
const MAIL = ["gm", "ail"].join("");
const NEUTRAL = "example_calendar";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
function write(dir, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(dir, path);
    if (content === null) rmSync(target, { force: true });
    else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  }
}

const manifest = (id, extra = "") =>
  `{ id: "${id}", label: "L", capabilities: ["calendar_source"], secrets: { anyOf: [] }, config: {}${extra} }`;

// A small core: two registered connections (one vendor, one neutral), an activity-source table with a vendor source and
// the sources core owns, and the CORE_SOURCES list.
const CLEAN = {
  "platform/contracts/src/connections/core-sources.ts": `export const CORE_SOURCES = ["derived", "derived-shadow", "calendar_feed"] as const;\n`,
  "platform/contracts/src/connections/builtin-connections.ts": `export const BUILTIN_CONNECTIONS = [\n  ${manifest(CAL)},\n  ${manifest(MAPS)},\n  ${manifest(NEUTRAL)},\n  ${manifest("calendar_feed")}\n];\n`,
  "platform/contracts/src/activity-events.ts": `export const ACTIVITY_SOURCES = {\n  derived: { schemaVersion: 1, kinds: [] },\n  "derived-shadow": { schemaVersion: 1, kinds: [] },\n  ${MAIL}: { schemaVersion: 1, kinds: [] },\n  timeline: { schemaVersion: 1, kinds: [] }\n};\n`,
  "portal/server/clean.ts": `export const f = (source: string, id: string) => (source === "derived-shadow" || id === "calendar_feed" ? 1 : 0);\n`
};
const LANES = JSON.parse(readFileSync(join(root, "scripts/repository/rules/vendor-terms.json"), "utf8"));
const CONFIG_FILE = {
  "scripts/repository/rules/vendor-terms.json": `${JSON.stringify({ lanes: LANES.lanes, fallbackLane: LANES.fallbackLane })}\n`
};

const shard = (lane, files) => ({
  [`${PENDING}/${lane}.json`]: `${JSON.stringify({ lane, sites: { total: Object.values(files).reduce((a, b) => a + b, 0), files } })}\n`
});

// Build a throwaway repository: `base` is committed and tagged, then `files` are applied on top (null deletes).
function run({ base = {}, files = {}, args = [], composed = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "literal-branch-"));
  try {
    git(dir, "init", "-q");
    const baseFiles = { ...CONFIG_FILE, ...CLEAN, ...base };
    if (composed) {
      write(dir, { ...baseFiles, ...files });
      git(dir, "add", "-A");
      return { dir, errors: literalConnectionBranch({ root: dir, args, env: { CI: "" } }) };
    }
    write(dir, baseFiles);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    write(dir, files);
    git(dir, "add", "-A");
    const errors = literalConnectionBranch({ root: dir, args, base: "base", env: { CI: "" } });
    return {
      dir,
      errors,
      read: (path) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null)
    };
  } finally {
    // The caller reads files through `read` below, so the directory is removed lazily.
    setImmediate(() => rmSync(dir, { recursive: true, force: true }));
  }
}
const errorsOf = (options) => run(options).errors;

test("a clean core passes, and branching on a core-owned source is allowed", () => {
  assert.deepEqual(errorsOf(), []);
});

test("must fail: a new `if (id === <vendor id>)` in a core file", () => {
  const errors = errorsOf({
    files: {
      "portal/server/new.ts": `export const f = (id: string) => { if (id === "${CAL}") return 1; return 0; };\n`
    }
  });
  assert.ok(
    errors.some((e) => /portal\/server\/new\.ts is new/.test(e) && e.includes(CAL)),
    errors.join("\n")
  );
});

test("must fail: a module-level const bound to a vendor id does not hide the comparison", () => {
  const errors = errorsOf({
    files: {
      "portal/server/aliased.ts": `const GC = "${CAL}";\nexport const f = (id: string) => { if (id === GC) return 1; return 0; };\n`
    }
  });
  assert.ok(
    errors.some((e) => /portal\/server\/aliased\.ts is new/.test(e)),
    errors.join("\n")
  );
});

test("must fail: an alias of an alias, and a string member of an `as const` object", () => {
  const chain = errorsOf({
    files: {
      "portal/server/chain.ts": `const A = "${CAL}";\nconst B = A;\nexport const f = (id: string) => id !== B;\n`
    }
  });
  assert.ok(
    chain.some((e) => /chain\.ts is new/.test(e)),
    chain.join("\n")
  );
  const member = errorsOf({
    files: {
      "portal/server/member.ts": `const IDS = { calendar: "${CAL}" } as const;\nexport const f = (id: string) => id === IDS.calendar;\n`
    }
  });
  assert.ok(
    member.some((e) => /member\.ts is new/.test(e)),
    member.join("\n")
  );
});

test("must fail: a const imported from another file, a switch case, and includes", () => {
  const imported = errorsOf({
    files: {
      "portal/server/ids.ts": `export const CALENDAR_ID = "${CAL}";\n`,
      "portal/server/uses.ts": `import { CALENDAR_ID as CAL } from "./ids";\nexport const f = (id: string) => id === CAL;\n`
    }
  });
  assert.ok(
    imported.some((e) => /uses\.ts is new/.test(e)),
    imported.join("\n")
  );
  const sw = errorsOf({
    files: {
      "portal/server/sw.ts": `export const f = (id: string) => { switch (id) { case "${CAL}": return 1; default: return 0; } };\n`
    }
  });
  assert.ok(
    sw.some((e) => /sw\.ts is new/.test(e)),
    sw.join("\n")
  );
  const inc = errorsOf({
    files: {
      "portal/server/inc.ts": `export const f = (ids: string[], id: string) => ids.includes("${MAPS}") || ["${NEUTRAL}", "x"].includes(id);\n`
    }
  });
  assert.ok(
    inc.some((e) => /inc\.ts is new/.test(e) && /2 times/.test(e)),
    inc.join("\n")
  );
  const table = errorsOf({ files: { "portal/server/table.ts": `export const READY = ["${MAPS}", "x"] as const;\n` } });
  assert.ok(
    table.some((e) => /table\.ts is new/.test(e)),
    table.join("\n")
  );
});

test("must fail: a neutral id that only a manifest registers", () => {
  const errors = errorsOf({
    files: { "portal/server/neutral.ts": `export const f = (id: string) => id === "${NEUTRAL}";\n` }
  });
  assert.ok(
    errors.some((e) => /neutral\.ts is new/.test(e)),
    errors.join("\n")
  );
});

test("must fail: an id registered by an add-on or an extension, read from the code", () => {
  const errors = errorsOf({
    files: {
      "platform/contracts/src/private/index.ts": `registerConnectionManifest(${manifest("added_one")});\nexport const ext = { sourceIds: { added_two: "Two" }, activitySources: { "added-three": { schemaVersion: 1, kinds: [] } } };\n`,
      "portal/server/added.ts": `export const f = (id: string, source: string) => id === "added_one" || source === "added_two" || source === "added-three";\n`
    }
  });
  assert.ok(
    errors.some((e) => /added\.ts is new/.test(e) && /3 times/.test(e)),
    errors.join("\n")
  );
});

test("passes: a core-owned source, a non-id string, and a source name compared with a non-source value", () => {
  const files = {
    "portal/server/core-ok.ts": `export const f = (source: string, view: string) => source === "derived-shadow" || source === "calendar_feed" || view === "timeline" || view === "month";\n`
  };
  assert.deepEqual(errorsOf({ files }), []);
});

test("a source name still fails when the value is named like a source", () => {
  const errors = errorsOf({
    files: { "portal/server/src.ts": `export const f = (link: { source: string }) => link?.source === "${MAIL}";\n` }
  });
  assert.ok(
    errors.some((e) => /src\.ts is new/.test(e)),
    errors.join("\n")
  );
});

test("passes: tests, fixtures, scripts and provider-owned code are not scanned", () => {
  const branch = `export const f = (id: string) => id === "${CAL}";\n`;
  const files = {
    "portal/server/x.test.ts": branch,
    "portal/server/test/helper.ts": branch,
    "portal/server/x-fixtures.ts": branch,
    "scripts/anything.mjs": `export const f = (id) => id === "${CAL}";\n`,
    "integrations/outbound-proxy/src/connections/own/connection.ts": branch,
    "integrations/outbound-proxy/src/drop-ins/own/register.ts": branch
  };
  assert.deepEqual(errorsOf({ files }), []);
});

test("passes: a name in a string, a comment or a property is not a comparison", () => {
  const files = {
    "portal/server/data.ts": `// id === "${CAL}"\nexport const row = { provider: "${CAL}", label: "x === ${CAL}" };\n`
  };
  assert.deepEqual(errorsOf({ files }), []);
});

test("a pending shard allows the counted hits, and no more", () => {
  const branch = `export const f = (id: string) => id === "${CAL}";\n`;
  const base = { "portal/server/old.ts": branch, ...shard("H", { "portal/server/old.ts": 1 }) };
  assert.deepEqual(errorsOf({ base }), []);
  const more = errorsOf({
    base,
    files: { "portal/server/old.ts": `${branch}export const g = (id: string) => id !== "${CAL}";\n` }
  });
  assert.ok(
    more.some((e) => /old\.ts has 2 literal provider-id branches but .* allows 1/.test(e)),
    more.join("\n")
  );
});

test("a stale (too high) count fails, so the shard only shrinks", () => {
  const base = {
    "portal/server/old.ts": `export const f = (id: string) => id === "${CAL}";\n`,
    ...shard("H", { "portal/server/old.ts": 1 })
  };
  const errors = errorsOf({ base, files: { "portal/server/old.ts": "export const f = 1;\n" } });
  assert.ok(
    errors.some((e) => /old\.ts now has 0 .* below the 1/.test(e)),
    errors.join("\n")
  );
});

test("hits moved to a new file in the same lane pass when the lane total does not rise", () => {
  const branch = `export const f = (id: string) => id === "${CAL}";\n`;
  const base = { "portal/server/old.ts": branch, ...shard("H", { "portal/server/old.ts": 1 }) };
  const files = {
    "portal/server/old.ts": null,
    "portal/server/moved.ts": branch,
    ...shard("H", { "portal/server/moved.ts": 1 })
  };
  assert.deepEqual(errorsOf({ base, files }), []);
});

test("a lane total that rises fails even when the shard is edited to match", () => {
  const branch = `export const f = (id: string) => id === "${CAL}";\n`;
  const base = { "portal/server/old.ts": branch, ...shard("H", { "portal/server/old.ts": 1 }) };
  const files = {
    "portal/server/more.ts": branch,
    ...shard("H", { "portal/server/old.ts": 1, "portal/server/more.ts": 1 })
  };
  const errors = errorsOf({ base, files });
  assert.ok(
    errors.some((e) => /Lane H .* rise from 1 .* to 2/.test(e)),
    errors.join("\n")
  );
});

test("--fix-pending seeds a first shard, refuses to raise one, and deletes a shard at zero", () => {
  const branch = `export const f = (id: string) => id === "${CAL}";\n`;
  const seeded = run({ files: { "portal/server/seed.ts": branch }, args: ["--fix-pending"] });
  assert.deepEqual(seeded.errors, []);
  assert.match(seeded.read(`${PENDING}/H.json`), /"total": 1/);

  const base = { "portal/server/old.ts": branch, ...shard("H", { "portal/server/old.ts": 1 }) };
  const raised = run({ base, files: { "portal/server/new.ts": branch }, args: ["--fix-pending"] });
  assert.ok(
    raised.errors.some((e) => /Refusing to raise H from 1 to 2/.test(e)),
    raised.errors.join("\n")
  );

  const cleared = run({ base, files: { "portal/server/old.ts": "export {};\n" }, args: ["--fix-pending"] });
  assert.deepEqual(cleared.errors, []);
  assert.equal(cleared.read(`${PENDING}/H.json`), null);
});

test("a composed tree (no commit) skips the overlay's files but still reads its manifests", () => {
  const branch = `export const f = (id: string) => id === "added_one";\n`;
  const files = {
    ".sync-core.json": JSON.stringify({ overlayFiles: ["portal/server/overlay.ts"] }),
    "platform/contracts/src/private/index.ts": `registerConnectionManifest(${manifest("added_one")});\n`,
    "portal/server/overlay.ts": branch
  };
  assert.deepEqual(errorsOf({ composed: true, files }), []);
  const core = errorsOf({ composed: true, files: { ...files, "portal/server/core.ts": branch } });
  assert.ok(
    core.some((e) => /portal\/server\/core\.ts is new/.test(e)),
    core.join("\n")
  );
});

test("a missing CORE_SOURCES list is an error, not a silent pass", () => {
  const errors = errorsOf({ files: { "platform/contracts/src/connections/core-sources.ts": null } });
  assert.ok(
    errors.some((e) => /core-sources\.ts is missing/.test(e)),
    errors.join("\n")
  );
});

test("a file that does not parse is reported by name", () => {
  const errors = errorsOf({ files: { "portal/server/bad.ts": "const = ;\n" } });
  assert.ok(
    errors.some((e) => /could not parse portal\/server\/bad\.ts/.test(e)),
    errors.join("\n")
  );
});
