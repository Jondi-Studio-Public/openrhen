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

const hit = (errors, file, times) =>
  errors.some((e) => e.includes(`${file} is new`) && (times === undefined || e.includes(`${times} time`)));
const fileOf = (name, body) => ({ [`portal/server/${name}.ts`]: body });

test("must fail: a provider id inside a SQL template or string, written as a column comparison", () => {
  const cases = {
    sqlEq: `export const q = (sql: any, u: string) => sql\`SELECT 1 FROM links WHERE user_id=\${u} AND provider='${CAL}'\`;\n`,
    sqlSpaced: `export const q = (sql: any) => sql\`SELECT 1 FROM t WHERE r.source = '${MAIL}' AND kind = 'x'\`;\n`,
    sqlIn: `export const q = (sql: any) => sql\`SELECT 1 FROM t WHERE connection IN ('${NEUTRAL}', 'other')\`;\n`,
    sqlNe: `export const q = (sql: any) => sql\`SELECT 1 FROM t WHERE provider <> '${MAPS}'\`;\n`,
    sqlPlain: `export const q = "SELECT 1 FROM t WHERE provider = '${CAL}'";\n`,
    sqlConst: `const PROVIDER = "${CAL}";\nexport const q = (sql: any) => sql\`SELECT 1 FROM t WHERE provider=\${PROVIDER}\`;\n`
  };
  for (const [name, body] of Object.entries(cases)) {
    const errors = errorsOf({ files: fileOf(name, body) });
    assert.ok(hit(errors, `portal/server/${name}.ts`, 1), `${name}: ${errors.join("\n")}`);
  }
  const two = errorsOf({
    files: fileOf(
      "sqlTwo",
      `export const q = (sql: any) => sql\`SELECT 1 FROM t WHERE provider='${CAL}' OR provider='${MAPS}'\`;\n`
    )
  });
  assert.ok(hit(two, "portal/server/sqlTwo.ts", 2), two.join("\n"));
});

test("passes: SQL that compares core sources, other columns or parameters", () => {
  const body = `export const q = (sql: any, p: string) => sql\`SELECT 1 FROM t WHERE source = 'derived' AND kind = '${CAL}' AND provider = \${p} AND label = 'provider'\`;\n`;
  assert.deepEqual(errorsOf({ files: fileOf("sqlOk", body) }), []);
});

test("must fail: a lookup table keyed by connection names, an `in` test, a Map and hasOwn", () => {
  const cases = {
    tableIndex: `const T: Record<string, number> = { ${MAPS}: 1, other: 2 };\nexport const f = (id: string) => T[id];\n`,
    tableComputed: `const K = "${CAL}";\nconst T = { [K]: 1 };\nexport const f = (id: string) => T[id];\n`,
    tableIn: `const T = { "${CAL}": 1 };\nexport const f = (id: string) => id in T;\n`,
    tableOwn: `const T = { "${CAL}": 1 };\nexport const f = (id: string) => Object.hasOwn(T, id) || T.hasOwnProperty(id);\n`,
    mapGet: `const M = new Map([["${CAL}", 1]]);\nexport const f = (id: string) => M.get(id);\n`,
    mapHas: `export const f = (id: string) => new Map([["${CAL}", 1]]).has(id);\n`,
    tableLocal: `export const f = (id: string) => { const T = { "${CAL}": 1 }; return T[id]; };\n`
  };
  for (const [name, body] of Object.entries(cases)) {
    const errors = errorsOf({ files: fileOf(name, body) });
    assert.ok(hit(errors, `portal/server/${name}.ts`), `${name}: ${errors.join("\n")}`);
  }
});

test("passes: tables keyed by other names, and a static key read", () => {
  const body = `const T = { month: 1, "${NEUTRAL}x": 2 };\nconst U = { "${CAL}": 1 };\nexport const f = (view: string) => T[view] + U["${CAL}"] + (view in T ? 1 : 0);\n`;
  assert.deepEqual(errorsOf({ files: fileOf("tableOk", body) }), []);
});

test("must fail: regex tests, startsWith, endsWith, localeCompare, Object.is and indexOf", () => {
  const cases = {
    regexLiteral: `export const f = (id: string) => /${MAPS}/i.test(id);\n`,
    regexAnchored: `export const f = (id: string) => /^${CAL}$/.exec(id) !== null;\n`,
    regexMatch: `export const f = (id: string) => id.match(/^(${CAL}|x)/);\n`,
    regexCtor: `export const f = (id: string) => new RegExp("^${CAL}$").test(id);\n`,
    starts: `export const f = (id: string) => id.startsWith("${CAL}:event:");\n`,
    startsPrefix: `export const f = (id: string) => id.startsWith("${MAPS}_");\n`,
    ends: `export const f = (id: string) => id.endsWith("${CAL}");\n`,
    locale: `export const f = (id: string) => id.localeCompare("${CAL}") === 0;\n`,
    objectIs: `export const f = (id: string) => Object.is(id, "${CAL}");\n`,
    indexOf: `export const f = (id: string) => ["x"].indexOf("${CAL}") + id.length;\n`
  };
  for (const [name, body] of Object.entries(cases)) {
    const errors = errorsOf({ files: fileOf(name, body) });
    assert.ok(hit(errors, `portal/server/${name}.ts`, 1), `${name}: ${errors.join("\n")}`);
  }
});

test("passes: a regex or prefix that names no connection", () => {
  const body = `export const f = (id: string) => /^\\d+$/.test(id) || id.startsWith("prefix:") || id.localeCompare("zzz") === 0 || Object.is(id, "none");\n`;
  assert.deepEqual(errorsOf({ files: fileOf("regexOk", body) }), []);
});

test("must fail: function-scoped const aliases, module-level let, default parameters", () => {
  const cases = {
    fnConst: `export const f = (id: string) => { const GC = "${CAL}"; return id === GC; };\n`,
    fnConstChain: `export function f(id: string) { const A = "${CAL}"; const B = A; if (id !== B) return 0; return 1; }\n`,
    fnConstMember: `export function f(id: string) { const IDS = { c: "${CAL}" } as const; return id === IDS.c; }\n`,
    modLet: `let GC = "${CAL}";\nexport const f = (id: string) => id === GC;\n`,
    defaultParam: `export function f(id: string, GC = "${CAL}") { return id === GC; }\n`,
    defaultArrow: `export const f = (id: string, GC: string = "${CAL}") => id === GC;\n`,
    nested: `const A = "${CAL}";\nexport const f = (id: string) => () => { switch (id) { case A: return 1; default: return 0; } };\n`,
    afterShadowScope: `const A = "${CAL}";\nexport function g(id: string, A: string) { return id === A; }\nexport const f = (id: string) => id === A;\n`
  };
  for (const [name, body] of Object.entries(cases)) {
    const errors = errorsOf({ files: fileOf(name, body) });
    assert.ok(hit(errors, `portal/server/${name}.ts`, 1), `${name}: ${errors.join("\n")}`);
  }
});

test("must fail: a re-exported const, through a named re-export, a renamed one, export * and an export list", () => {
  const ids = {
    "portal/server/ids.ts": `const RAW = "${CAL}";\nexport { RAW as PUBLIC_ID };\n`,
    "portal/server/barrel.ts": `export { PUBLIC_ID as RENAMED } from "./ids";\n`,
    "portal/server/barrel-all.ts": `export * from "./barrel";\n`
  };
  for (const [name, body] of Object.entries({
    direct: `import { PUBLIC_ID } from "./ids";\nexport const f = (id: string) => id === PUBLIC_ID;\n`,
    renamed: `import { RENAMED } from "./barrel";\nexport const f = (id: string) => id === RENAMED;\n`,
    star: `import { RENAMED as R } from "./barrel-all";\nexport const f = (id: string) => id === R;\n`,
    namespace: `import * as ids from "./ids";\nexport const f = (id: string) => id === ids.PUBLIC_ID;\n`
  })) {
    const errors = errorsOf({ files: { ...ids, ...fileOf(name, body) } });
    assert.ok(hit(errors, `portal/server/${name}.ts`, 1), `${name}: ${errors.join("\n")}`);
  }
});

test("passes: a parameter or local that shadows a module const is not the provider id", () => {
  const cases = {
    param: `const A = "${CAL}";\nexport function f(id: string, A: string) { return id === A; }\nexport const g = () => A;\n`,
    arrowParam: `const A = "${CAL}";\nexport const f = (id: string, A: string) => id === A;\n`,
    local: `const A = "${CAL}";\nexport function f(id: string) { const A = id.trim(); return id === A; }\n`,
    localOther: `const A = "${CAL}";\nexport function f(id: string) { const A = "other"; return id === A; }\n`,
    block: `const A = "${CAL}";\nexport function f(id: string) { { let A = id.trim(); if (id === A) return 1; } return 0; }\n`,
    destructured: `const A = "${CAL}";\nexport function f(id: string, { A }: { A: string }) { return id === A; }\n`,
    catchParam: `const A = "${CAL}";\nexport function f(id: string) { try { return 1; } catch (A) { return id === A; } }\n`,
    fnName: `const A = "${CAL}";\nexport function f(id: string) { function A() { return id; } return id === A(); }\n`
  };
  for (const [name, body] of Object.entries(cases)) {
    assert.deepEqual(errorsOf({ files: fileOf(`shadow${name}`, body) }), [], name);
  }
});

test("passes: indexing the ACTIVITY_SOURCES registry, and a regex over text that is not an id", () => {
  const body = `import { ACTIVITY_SOURCES } from "../../platform/contracts/src/activity-events";\nexport const f = (source: string, lower: string) => ACTIVITY_SOURCES[source]?.kinds ?? (/${MAPS} photos/.test(lower) ? 1 : 0);\n`;
  assert.deepEqual(errorsOf({ files: fileOf("registry", body) }), []);
});

test("an SQL hit is counted on the line it is written on", () => {
  const body = `export const q = (sql: any) => sql\`\n  SELECT 1\n  WHERE provider = '${CAL}'\n\`;\n`;
  const result = errorsOf({ files: fileOf("sqlLine", body) });
  assert.ok(
    result.some((e) => /line 3 /.test(e)),
    result.join("\n")
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
