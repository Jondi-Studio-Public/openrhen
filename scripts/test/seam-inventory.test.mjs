import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkGenerated, checkInventory, scanSource } from "../repository/seam-inventory.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = "scripts/repository/rules/vendor-terms.json";
const SHARDS = "scripts/repository/pending/seam-inventory";
const names = (file, source) => scanSource(file, source).registries.map((entry) => entry.name);

// ---------------------------------------------------------------------------------------------------------------------
// The C5 forms: an exported function or const arrow, whatever its name, whose body changes a module-level collection.
// ---------------------------------------------------------------------------------------------------------------------
const FORMS = [
  [
    "register-named function with Map.set",
    "const items = new Map();\nexport function registerItem(id, item) { items.set(id, item); }\n",
    ["registerItem"]
  ],
  [
    "renamed attach() form: no register in the name",
    "const items = new Map();\nexport function attach(id, item) { items.set(id, item); }\n",
    ["attach"]
  ],
  ["const arrow", "const items = new Set();\nexport const attach = (id) => { items.add(id); };\n", ["attach"]],
  ["expression-bodied arrow", "const items = [];\nexport const attach = (id) => items.push(id);\n", ["attach"]],
  [
    "function expression assigned to a const",
    "const items = [];\nexport const attach = async function (id) { items.push(id); };\n",
    ["attach"]
  ],
  [
    "add*-style name on an array push",
    "const hooks = [];\nexport function addHook(hook) { hooks.push(hook); }\n",
    ["addHook"]
  ],
  ["splice", "const list = [];\nexport function drop(i) { list.splice(i, 1); }\n", ["drop"]],
  [
    "index assignment on an object",
    "const table = {};\nexport function put(key, value) { table[key] = value; }\n",
    ["put"]
  ],
  [
    "index assignment through a nested path",
    "const table = { rows: {} };\nexport function put(key, value) { table.rows[key] = value; }\n",
    ["put"]
  ],
  ["delete", "const table = {};\nexport function remove(key) { delete table[key]; }\n", ["remove"]],
  [
    "Object.assign on a top-level binding",
    "const defaults = {};\nexport function extend(more) { Object.assign(defaults, more); }\n",
    ["extend"]
  ],
  [
    "a mutation inside the teardown closure it returns",
    "const items = new Map();\nexport function attach(id) { return () => { items.delete(id); delete items[id]; }; }\n",
    ["attach"]
  ],
  [
    "a TypeScript cast and a non-null assertion do not hide the root",
    "const items = new Map<string, string[]>();\nexport function attach(id: string, v: string) { (items.get(id) as string[]).push(v); items!.set(id, [v]); }\n",
    ["attach"]
  ],
  ["optional chaining", "const items = new Map();\nexport function attach(id) { items?.set(id, 1); }\n", ["attach"]],
  [
    "a non-exported helper that writes, called by an exported function",
    "const items = new Map();\nfunction store(id) { items.set(id, 1); }\nexport function attach(id) { store(id); }\n",
    ["attach"]
  ],
  [
    "a helper reached through two levels",
    "const items = new Map();\nfunction store(id) { items.set(id, 1); }\nconst middle = (id) => store(id);\nexport const attach = (id) => middle(id);\n",
    ["attach"]
  ],
  [
    "export list and renamed export",
    "const items = new Map();\nfunction attach(id) { items.set(id, 1); }\nexport { attach as register };\n",
    ["register"]
  ],
  ["default export", "const items = new Map();\nexport default function (id) { items.set(id, 1); }\n", ["default"]],
  [
    "a let binding and a destructured binding",
    "let [first, second] = [[], []];\nexport function attach(a) { second.push(a); }\n",
    ["attach"]
  ],
  [
    "two registries in one file",
    "const a = new Map();\nconst b = new Set();\nexport const one = (x) => a.set(x, 1);\nexport function two(x) { b.add(x); }\n",
    ["one", "two"]
  ]
];
for (const [label, source, expected] of FORMS) {
  test(`finds ${label}`, () => {
    assert.deepEqual(names("src/example.ts", source), expected);
  });
}

const NOT_REGISTRIES = [
  ["a local collection", "export function build(id) { const items = new Map(); items.set(id, 1); return items; }\n"],
  [
    "a parameter that shadows the module binding",
    "const items = new Map();\nexport function fill(items, id) { items.set(id, 1); }\n"
  ],
  [
    "a local that shadows the module binding",
    "const items = new Map();\nexport function fill(id) { const items = []; items.push(id); return items; }\n"
  ],
  ["a function that only reads", "const items = new Map();\nexport function find(id) { return items.get(id); }\n"],
  [
    "a non-exported function that writes and is never reached from an export",
    "const items = new Map();\nfunction store(id) { items.set(id, 1); }\nexport const size = () => items.size;\n"
  ],
  ["a class with only per-instance state", "export class Bag { items = []; add(x) { this.items.push(x); } }\n"],
  ["an imported binding", "import { items } from './items.js';\nexport function read() { return items.length; }\n"],
  [
    "a function-scoped array that is returned",
    "export const collect = (xs) => { const out = []; for (const x of xs) out.push(x); return out; };\n"
  ],
  [
    "a test-shaped name that writes nothing",
    "const items = new Map();\nexport function registerNothing() { return items.size; }\n"
  ]
];
for (const [label, source] of NOT_REGISTRIES) {
  test(`does not flag ${label}`, () => {
    assert.deepEqual(names("src/example.ts", source), []);
  });
}

test("a @seam tag does not exempt a plain collection-writing export", () => {
  const tagged =
    "const items = new Map();\n/**\n * Things.\n * @seam things\n */\nexport function attach(id) { items.set(id, 1); }\n";
  assert.deepEqual(names("src/example.ts", tagged), ["attach"]);
  const taggedExport = "const items = new Map();\n/** @seam */\nexport const attach = (id) => { items.add(id); };\n";
  assert.deepEqual(names("src/example.ts", taggedExport), ["attach"]);
});

test("the C5 forms beyond plain functions", () => {
  // a class whose static collection an exported method writes (this. and ClassName. forms)
  assert.deepEqual(
    names(
      "a.ts",
      "export class Hooks {\n  static items = new Map<string, number>();\n  static add(k: string) { this.items.set(k, 1); }\n  static put(k: string) { Hooks.items.set(k, 2); }\n  static size() { return Hooks.items.size; }\n}\n"
    ),
    ["Hooks.add", "Hooks.put"]
  );
  // an instance method writing the module-level collection
  assert.deepEqual(names("a.ts", "const m = new Map();\nexport class Bag { add(k) { m.set(k, 1); } }\n"), ["Bag.add"]);
  // an instance field is per-instance, not a registry
  assert.deepEqual(names("a.ts", "export class Bag { items = new Map(); add(k) { this.items.set(k, 1); } }\n"), []);
  // an object-literal API: method, arrow and function-expression members
  assert.deepEqual(
    names(
      "a.ts",
      "const m = new Map();\nexport const api = { register(k, v) { m.set(k, v); }, put: (k) => m.set(k, 1), take: function (k) { m.delete(k); delete m[k]; }, size: () => m.size };\n"
    ),
    ["api.register", "api.put", "api.take"]
  );
  assert.deepEqual(
    names("a.ts", "const m = new Map();\nexport const api = { register(k) { m.set(k, 1); } } as const;\n"),
    ["api.register"]
  );
  // an imported collection written from an exported function, in each import form
  assert.deepEqual(names("a.ts", 'import { m } from "./x";\nexport function add(k) { m.set(k, 1); }\n'), ["add"]);
  assert.deepEqual(names("a.ts", 'import { m as table } from "./x";\nexport const add = (k) => { table[k] = 1; };\n'), [
    "add"
  ]);
  assert.deepEqual(names("a.ts", 'import m from "./x";\nexport function add(k) { m.push(k); }\n'), ["add"]);
  assert.deepEqual(names("a.ts", 'import * as x from "./x";\nexport function add(k) { x.m.set(k, 1); }\n'), ["add"]);
  // a type-only import is not a collection
  assert.deepEqual(names("a.ts", 'import type { m } from "./x";\nexport function add(k) { m.set(k, 1); }\n'), []);
  // a shadowed import is not
  assert.deepEqual(names("a.ts", 'import { m } from "./x";\nexport function add(m, k) { m.set(k, 1); }\n'), []);
});

test("reports line numbers", () => {
  const found = scanSource(
    "src/example.ts",
    "const items = new Map();\n\nexport function attach(id) { items.set(id, 1); }\n"
  );
  assert.deepEqual(found.registries, [{ name: "attach", line: 3 }]);
});

test("parses .tsx and .mjs", () => {
  assert.deepEqual(names("a.mjs", "const m = new Map();\nexport const attach = (k) => m.set(k, 1);\n"), ["attach"]);
  assert.deepEqual(
    names(
      "a.tsx",
      "const m = new Map();\nexport const View = () => <div/>;\nexport const attach = (k: string) => m.set(k, 1);\n"
    ),
    ["attach"]
  );
});

test("a file that does not parse fails loudly instead of being skipped", () => {
  assert.throws(() => scanSource("src/broken.ts", "export function ( {"), /could not parse src\/broken\.ts/);
});

// ---------------------------------------------------------------------------------------------------------------------
// createRegistry calls: they must carry a @seam tag and literal name and key; the generated seam list reads them.
// ---------------------------------------------------------------------------------------------------------------------
test("a tagged createRegistry call is a seam with its name, module and key", () => {
  const source =
    'import { createRegistry } from "@openrhen/contracts/extension";\n/** @seam */\nexport const profiles = createRegistry<Profile>({ name: "diff-profiles", key: "profile id" });\n';
  const found = scanSource("portal/server/profiles.ts", source);
  assert.deepEqual(found.seams, [{ name: "diff-profiles", module: "portal/server/profiles.ts", key: "profile id" }]);
  assert.deepEqual(found.errors, []);
  assert.deepEqual(found.registries, []);
});

const SEAM_ONE = (call, head = 'import { createRegistry } from "@openrhen/contracts/extension";\n') =>
  `${head}/** @seam */\nexport const profiles = ${call}({ name: "diff-profiles", key: "profile id" });\n`;
const THE_SEAM = [{ name: "diff-profiles", module: "a.ts", key: "profile id" }];

test("an aliased import of createRegistry is still a seam", () => {
  const found = scanSource(
    "a.ts",
    SEAM_ONE("cr", 'import { createRegistry as cr } from "@openrhen/contracts/extension";\n')
  );
  assert.deepEqual(found.errors, []);
  assert.deepEqual(found.seams, THE_SEAM);
});

test("a namespace call of createRegistry is still a seam", () => {
  const found = scanSource(
    "a.ts",
    SEAM_ONE("c.createRegistry", 'import * as c from "@openrhen/contracts/extension";\n')
  );
  assert.deepEqual(found.errors, []);
  assert.deepEqual(found.seams, THE_SEAM);
});

test("a relative import of createRegistry (inside contracts) is still a seam", () => {
  for (const head of [
    'import { createRegistry } from "./extension/registry.js";\n',
    'import { createRegistry as make } from "../extension/registry";\n'
  ]) {
    const call = head.includes(" as make") ? "make" : "createRegistry";
    const found = scanSource("a.ts", SEAM_ONE(call, head));
    assert.deepEqual(found.errors, [], head);
    assert.deepEqual(found.seams, THE_SEAM, head);
  }
  const found = scanSource("a.ts", SEAM_ONE("c.createRegistry", 'import * as c from "../extension/registry.js";\n'));
  assert.deepEqual(found.seams, THE_SEAM);
});

test("an aliased createRegistry call without a @seam tag is an error too", () => {
  const source =
    'import { createRegistry as cr } from "@openrhen/contracts/extension";\nexport const profiles = cr({ name: "n", key: "k" });\n';
  assert.equal(scanSource("a.ts", source).errors.length, 1);
});

test("the @seam tag is matched as a token, not as a prefix", () => {
  for (const tag of ["@seam-less", "@seams", "@seam_x", "@seamless"]) {
    const source = `/** ${tag} */\nexport const p = createRegistry({ name: "n", key: "k" });\n`;
    const found = scanSource("a.ts", source);
    assert.equal(found.errors.length, 1, tag);
    assert.deepEqual(found.seams, [], tag);
  }
  for (const comment of ["/** @seam */", "/**\n * Docs.\n * @seam\n */", "// @seam", "/** @seam things */"]) {
    const found = scanSource("a.ts", `${comment}\nexport const p = createRegistry({ name: "n", key: "k" });\n`);
    assert.deepEqual(found.errors, [], comment);
    assert.equal(found.seams.length, 1, comment);
  }
});

test("a createRegistry call without a @seam tag is an error", () => {
  const source = 'const profiles = createRegistry({ name: "diff-profiles", key: "profile id" });\n';
  const found = scanSource("portal/server/profiles.ts", source);
  assert.equal(found.errors.length, 1);
  assert.match(found.errors[0], /portal\/server\/profiles\.ts:1 .*@seam/);
});

test("a createRegistry call needs a literal name and key", () => {
  const source = "const NAME = 'x';\n/** @seam */\nconst profiles = createRegistry({ name: NAME, key: 'k' });\n";
  const found = scanSource("a.ts", source);
  assert.equal(found.errors.length, 1);
  assert.match(found.errors[0], /literal/);
});

// ---------------------------------------------------------------------------------------------------------------------
// The inventory against a tree: pending shards, new registries, stale entries, lane totals, composed trees.
// ---------------------------------------------------------------------------------------------------------------------
const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
const REGISTRY = "const items = new Map();\nexport function attach(id) { items.set(id, 1); }\n";
const shard = (lane, files) =>
  `${JSON.stringify(
    {
      lane,
      registries: { total: Object.values(files).reduce((sum, list) => sum + list.length, 0), files }
    },
    null,
    2
  )}\n`;
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
// base is committed; files are then applied and staged; the inventory runs with the base commit as the comparison.
function run({ base = {}, files = {}, args = [], composed = false, generated = false }) {
  const dir = mkdtempSync(join(tmpdir(), "seam-inventory-"));
  try {
    const baseFiles = {
      [CONFIG]: readFileSync(join(root, CONFIG), "utf8"),
      "src/clean.ts": "export const clean = 1;\n",
      ...base
    };
    git(dir, "init", "-q");
    if (composed) {
      write(dir, { ...baseFiles, ...files });
      git(dir, "add", "-A");
      return checkInventory({ root: dir, args, env: { CI: "" } });
    }
    write(dir, baseFiles);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "tag", "base");
    write(dir, files);
    git(dir, "add", "-A");
    const errors = checkInventory({ root: dir, args, base: "base", env: { CI: "" } });
    return generated ? { errors, dir: null, generated: checkGenerated({ root: dir }) } : errors;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a pending registry that is listed in its lane shard passes", () => {
  const files = { "src/reg.ts": REGISTRY, [`${SHARDS}/other.json`]: shard("other", { "src/reg.ts": ["attach"] }) };
  assert.deepEqual(run({ base: files }), []);
});

test("a new registry that is neither pending, tagged nor on createRegistry fails and says what to do", () => {
  const errors = run({ files: { "src/new-reg.ts": REGISTRY } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /src\/new-reg\.ts:\d+ exports attach/);
  assert.match(errors[0], /createRegistry/);
  assert.match(errors[0], /@seam/);
});

test("a new registry that is renamed to dodge a name rule still fails", () => {
  const files = { "src/reg.ts": REGISTRY, [`${SHARDS}/other.json`]: shard("other", { "src/reg.ts": ["attach"] }) };
  const errors = run({
    base: files,
    files: {
      "src/reg.ts": REGISTRY + "export const wire = (id) => { items.set(id, 2); };\n"
    }
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /src\/reg\.ts:\d+ exports wire/);
});

test("a registry on createRegistry with a @seam tag needs no shard entry; a bare @seam tag is no way out", () => {
  const onRegistry =
    'import { createRegistry } from "@openrhen/contracts/extension";\n/** @seam */\nexport const things = createRegistry({ name: "things", key: "thing id" });\n';
  assert.deepEqual(run({ files: { "src/on-registry.ts": onRegistry } }), []);
  const bare = "const items = new Map();\n/** @seam */\nexport function attach(id) { items.set(id, 1); }\n";
  const errors = run({ files: { "src/bare.ts": bare } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /src\/bare\.ts:\d+ exports attach/);
});

test("a test file is not scanned", () => {
  assert.deepEqual(
    run({
      files: {
        "src/reg.test.ts": REGISTRY,
        "scripts/test/fixtures/x/reg.ts": REGISTRY,
        "src/test/reg.ts": REGISTRY,
        "src/server-test-support.ts": REGISTRY,
        "src/state-store-harness.ts": REGISTRY
      }
    }),
    []
  );
});

test("a stale entry (the registry is gone) fails and says to lower the shard", () => {
  const files = { "src/reg.ts": REGISTRY, [`${SHARDS}/other.json`]: shard("other", { "src/reg.ts": ["attach"] }) };
  const errors = run({ base: files, files: { "src/reg.ts": "export const gone = 1;\n" } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /src\/reg\.ts .*stale.*attach/s);
});

test("a shard whose total does not add up fails", () => {
  const bad = JSON.stringify({ lane: "other", registries: { total: 5, files: { "src/reg.ts": ["attach"] } } });
  const errors = run({ base: { "src/reg.ts": REGISTRY, [`${SHARDS}/other.json`]: bad } });
  assert.ok(errors.some((error) => /total is 5/.test(error)));
});

test("a shard entry in the wrong lane fails", () => {
  const files = { "src/reg.ts": REGISTRY, [`${SHARDS}/K.json`]: shard("K", { "src/reg.ts": ["attach"] }) };
  assert.ok(run({ base: files }).some((error) => /belongs to lane other/.test(error)));
});

test("a lane total never rises in a pull request, even when the shard is kept in step", () => {
  const before = { "src/a.ts": REGISTRY, [`${SHARDS}/other.json`]: shard("other", { "src/a.ts": ["attach"] }) };
  const errors = run({
    base: before,
    files: {
      "src/b.ts": REGISTRY,
      [`${SHARDS}/other.json`]: shard("other", { "src/a.ts": ["attach"], "src/b.ts": ["attach"] })
    }
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Lane other .*rises from 1 .* to 2/);
});

test("registries that move to a new file in the same lane pass when the total stays level", () => {
  const before = { "src/a.ts": REGISTRY, [`${SHARDS}/other.json`]: shard("other", { "src/a.ts": ["attach"] }) };
  const errors = run({
    base: before,
    files: {
      "src/a.ts": null,
      "src/b.ts": REGISTRY,
      [`${SHARDS}/other.json`]: shard("other", { "src/b.ts": ["attach"] })
    }
  });
  assert.deepEqual(errors, []);
});

test("--fix-pending seeds the shards of a rule that did not exist at the base, one per lane", () => {
  const dir = mkdtempSync(join(tmpdir(), "seam-inventory-"));
  try {
    write(dir, {
      [CONFIG]: readFileSync(join(root, CONFIG), "utf8"),
      "src/reg.ts": REGISTRY,
      "platform/contracts/src/k.ts": REGISTRY
    });
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    assert.deepEqual(checkInventory({ root: dir, args: ["--fix-pending"], env: { CI: "" } }), []);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, SHARDS, "other.json"), "utf8")), {
      lane: "other",
      registries: { total: 1, files: { "src/reg.ts": ["attach"] } }
    });
    assert.equal(JSON.parse(readFileSync(join(dir, SHARDS, "K.json"), "utf8")).registries.total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--fix-pending refuses to raise a lane above the base", () => {
  const before = { "src/a.ts": REGISTRY, [`${SHARDS}/other.json`]: shard("other", { "src/a.ts": ["attach"] }) };
  const errors = run({ base: before, files: { "src/b.ts": REGISTRY }, args: ["--fix-pending"] });
  assert.ok(errors.some((error) => /Refusing to raise other from 1 to 2/.test(error)));
});

test("in a composed tree (no commit) files the sync lists as overlay are not core registries", () => {
  const files = {
    "src/reg.ts": REGISTRY,
    "overlay-owned/reg.ts": REGISTRY,
    ".sync-core.json": JSON.stringify({ overlayFiles: ["overlay-owned/reg.ts"] }),
    [`${SHARDS}/other.json`]: shard("other", { "src/reg.ts": ["attach"] })
  };
  assert.deepEqual(run({ composed: true, files }), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// The generated seam list.
// ---------------------------------------------------------------------------------------------------------------------
test("the generated files are checked against the tree and named when stale", () => {
  const tagged = 'const x = createRegistry({ name: "diff-profiles", key: "profile id" });\n';
  const source = `/** @seam */\nexport ${tagged}`;
  const { generated } = run({ base: { "src/profiles.ts": source }, generated: true });
  assert.ok(generated.some((error) => /docs\/protocol\/seams\.generated\.json/.test(error)));
  assert.ok(generated.some((error) => /docs\/protocol\/seams\.generated\.md/.test(error)));
  assert.ok(generated.every((error) => /seams:generate/.test(error)));
});

// ---------------------------------------------------------------------------------------------------------------------
// The real tree: this is C5/S2's number of record. Red until the shards and the generated files exist.
// ---------------------------------------------------------------------------------------------------------------------
test("every registry in the tracked tree is pending, @seam tagged or on createRegistry", () => {
  assert.deepEqual(checkInventory({ root }), []);
});

test("docs/protocol/seams.generated.* match the tree", () => {
  assert.deepEqual(checkGenerated({ root }), []);
});
