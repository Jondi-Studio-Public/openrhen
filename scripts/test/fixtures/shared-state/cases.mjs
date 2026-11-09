// Fixtures for the shared-state ratchets (modularity plan A2: S1 side-effect-imports, S4 env-readers, S5 and S5b
// module-state). Each case builds a throwaway git repository: `base` is committed, then `files` (null deletes) and
// `shards` are written to the working tree and the rule is run against the base commit.
//   rule      the rule module under test
//   base      files committed at the base commit
//   baseShards  lane -> shard committed at the base (omitted or {} = the rule did not exist yet: bootstrap)
//   files     working-tree changes on top of the base
//   shards    the shards in the working tree (default: the base shards, unchanged)
//   composed  no HEAD commit, with a .sync-core.json: the composed (core plus overlay) tree
//   expect    regular expressions that must each match some error; absent = the rule must pass
export const RULES = {
  "side-effect-imports": { metric: "effects", file: "portal/server/x.ts" },
  "env-readers": { metric: "reads", file: "portal/server/x.ts" },
  "module-state": { metric: "state", file: "portal/server/x.ts" }
};

export const shard = (lane, metric, files) => ({
  lane,
  [metric]: { total: Object.values(files).reduce((a, b) => a + b, 0), files }
});

const imp = (name) => `import "${name}"\n`;
const must = (rule, name, files, expect, extra = {}) => ({ rule, name, files, expect, ...extra });
const pass = (rule, name, files, extra = {}) => ({ rule, name, files, ...extra });

const S1 = "side-effect-imports";
const S4 = "env-readers";
const S5 = "module-state";

// One sample hit per rule, for the ratchet behaviours that are the same for every rule.
export const SAMPLE = {
  [S1]: { hit: (i) => imp(`./private/index${i}`), clean: "export const a = 1;\n", noun: /side-effect/ },
  [S4]: { hit: (i) => `export const a${i} = process.env.A;\n`, clean: "export const a = 1;\n", noun: /env read/ },
  [S5]: { hit: (i) => `export let a${i} = 1;\n`, clean: "export const a = 1;\n", noun: /module-level/ }
};

const hits = (rule, n) => Array.from({ length: n }, (_, i) => SAMPLE[rule].hit(i)).join("");

// ----------------------------------------------------------------- per-rule definition cases
export const CASES = [
  // ---- S1: module-load side effects
  must(
    S1,
    'a bare import without a semicolon: import "./private/index"',
    { "portal/server/x.ts": imp("./private/index") },
    [/portal\/server\/x\.ts is new .*1 module-load side effect.*line 1.*bare import/s, /boot\.ts/]
  ),
  must(S1, "a bare import with a semicolon", { "engine/worker/src/x.ts": 'import "./register";\n' }, [
    /engine\/worker\/src\/x\.ts is new/
  ]),
  must(
    S1,
    "a bare import in a .tsx file",
    { "portal/app/x.tsx": 'import "./register";\nexport default function X() { return null; }\n' },
    [/portal\/app\/x\.tsx is new/]
  ),
  must(S1, "a top-level await import()", { "portal/server/x.ts": 'await import("./x");\n' }, [/await import\(\)/]),
  must(
    S1,
    "a top-level await import() inside a const",
    { "portal/server/x.ts": 'const mod = await import("./x");\nexport default mod;\n' },
    [/await import\(\)/]
  ),
  must(S1, "a top-level require()", { "tools/cli/src/x.mjs": 'require("./x");\n' }, [/require\(\)/]),
  must(
    S1,
    "a top-level eager import.meta.glob",
    { "portal/server/x.ts": 'export const mods = import.meta.glob("./drop-ins/*.ts", { eager: true });\n' },
    [/eager import\.meta\.glob/]
  ),
  must(
    S1,
    "a bare import in boot.tsx (only boot.ts is the composition root)",
    { "portal/server/boot.tsx": imp("./x") },
    [/portal\/server\/boot\.tsx is new/]
  ),
  must(
    S1,
    "an eager import.meta.glob inside a function (the bundler hoists it into static imports)",
    {
      "tools/cli/src/x.ts":
        'export function f() {\n  return import.meta.glob("../ext/*.ts", { eager: true, import: "default" });\n}\n'
    },
    [/tools\/cli\/src\/x\.ts is new .*eager import\.meta\.glob/s]
  ),
  must(
    S1,
    "a bare import with a comment between import and the source",
    { "portal/server/x.ts": 'import /* x */ "./register";\n' },
    [/portal\/server\/x\.ts is new/]
  ),
  must(
    S1,
    "a bare import written with an empty specifier list",
    { "portal/server/x.ts": 'import {} from "./register";\n' },
    [/portal\/server\/x\.ts is new/]
  ),
  must(
    S1,
    "a bare import in a .js, .jsx, .cjs, .mts and .cts file",
    {
      "portal/server/a.js": 'import "./register";\n',
      "portal/server/b.jsx": 'import "./register";\n',
      "portal/server/c.cjs": 'require("./register");\n',
      "portal/server/d.mts": 'import "./register";\n',
      "portal/server/e.cts": 'import "./register";\n'
    },
    [/a\.js is new/, /b\.jsx is new/, /c\.cjs is new/, /d\.mts is new/, /e\.cts is new/]
  ),
  pass(S1, "css, server-only and client-only bare imports", {
    "portal/app/x.tsx": 'import "./globals.css";\nimport "server-only";\nimport "client-only";\n'
  }),
  pass(S1, "a bare import in boot.ts (the composition root)", { "portal/server/boot.ts": imp("./private/index") }),
  pass(S1, "a bare import in a nested boot.ts", { "engine/worker/src/host/boot.ts": imp("./x") }),
  pass(S1, "a bare import in a test file", { "portal/server/x.test.ts": imp("./x") }),
  pass(S1, "a bare import under a test folder", { "portal/server/test/setup.ts": imp("./x") }),
  pass(S1, "a bare import in a vitest config", { "portal/vitest.config.ts": imp("./x") }),
  pass(S1, "a bare import in a vitest-setup file", { "portal/vitest-setup.ts": imp("./x") }),
  pass(S1, "a bare import in a *-harness.ts that imports vitest", {
    "platform/database/src/state-store-harness.ts":
      'import { vi } from "vitest";\nimport "./x";\nexport const v = vi;\n'
  }),
  pass(S1, "an ordinary import, a type import and a lazy glob", {
    "portal/server/x.ts":
      'import { a } from "./a";\nimport type {} from "./b";\nexport const m = import.meta.glob("./*.ts");\nexport const n = import.meta.glob("./*.ts", { eager: false });\nexport const o = [a];\n'
  }),
  pass(S1, "an await import(), require() and eager glob inside functions", {
    "portal/server/x.ts":
      'export async function load() {\n  await import("./x");\n  const r = require("./y");\n  return r;\n}\n'
  }),
  pass(S1, "a bare import only in a comment or a string", {
    "portal/server/x.ts": '// import "./x"\nexport const s = \'import "./x"\';\n'
  }),
  pass(S1, "a d.ts file and a file outside the five roots", {
    "portal/server/x.d.ts": 'import "./x";\n',
    "scripts/x.mjs": 'import "./x";\n'
  }),

  // ---- S4: env reads
  must(S4, "const {env} = process", { "portal/server/x.ts": "const { env } = process;\nexport const a = env.A;\n" }, [
    /portal\/server\/x\.ts is new .*1 env read.*line 1.*config module/s
  ]),
  must(
    S4,
    "const {env: e} = globalThis.process",
    { "portal/server/x.ts": "const { env: e } = globalThis.process;\nexport const a = e.A;\n" },
    [/env read/]
  ),
  must(S4, "import.meta.env.X", { "portal/server/x.ts": "export const a = import.meta.env.X;\n" }, [
    /import\.meta\.env/
  ]),
  must(S4, "globalThis.process.env", { "portal/server/x.ts": "export const a = globalThis.process.env.A;\n" }, [
    /env read/
  ]),
  must(S4, 'process["env"]', { "portal/server/x.ts": 'export const a = process["env"].A;\n' }, [/env read/]),
  must(
    S4,
    "export const env = process.env in a non-config file",
    { "portal/server/x.ts": "export const env = process.env;\n" },
    [/portal\/server\/x\.ts is new .*1 env read/s]
  ),
  must(
    S4,
    "process.env as a default argument",
    {
      "engine/service/src/x.ts":
        "export function f(env: Record<string, string | undefined> = process.env) {\n  return env.A;\n}\n"
    },
    [/engine\/service\/src\/x\.ts is new .*1 env read/s]
  ),
  must(
    S4,
    'import {env} from "node:process"',
    { "portal/server/x.ts": 'import { env } from "node:process";\nexport const a = env.A;\n' },
    [/env read/]
  ),
  must(S4, "process.env in a .mjs tool", { "tools/cli/src/x.mjs": "export const a = process.env.A;\n" }, [
    /tools\/cli\/src\/x\.mjs is new/
  ]),
  must(
    S4,
    "a config module that does not exist yet is not an allowed home elsewhere",
    { "portal/server/config.ts": "export const a = process.env.A;\n" },
    [/portal\/server\/config\.ts is new/]
  ),
  must(
    S4,
    "(process as NodeJS.Process).env",
    { "portal/server/x.ts": "export const a = (process as NodeJS.Process).env.A;\n" },
    [/env read/]
  ),
  must(
    S4,
    "(globalThis as any).process.env",
    { "portal/server/x.ts": "export const a = (globalThis as any).process.env.A;\n" },
    [/env read/]
  ),
  must(
    S4,
    "process!.env and <X>process.env",
    { "portal/server/x.ts": "export const a = process!.env.A;\nexport const b = (<any>process).env.B;\n" },
    [/2 env reads/]
  ),
  must(S4, "const p = process; p.env", { "portal/server/x.ts": "const p = process;\nexport const a = p.env.A;\n" }, [
    /env read/
  ]),
  must(
    S4,
    "an alias of an alias and of globalThis",
    {
      "portal/server/x.ts": "const g = globalThis;\nconst p = g.process;\nconst q = p;\nexport const a = q.env.A;\n"
    },
    [/env read/]
  ),
  must(
    S4,
    'import process from "node:process"',
    { "portal/server/x.ts": 'import process from "node:process";\nexport const a = process.env.A;\n' },
    [/env read/]
  ),
  must(
    S4,
    'import * as proc from "node:process"',
    { "portal/server/x.ts": 'import * as proc from "node:process";\nexport const a = proc.env.A;\n' },
    [/env read/]
  ),
  must(
    S4,
    'import p from "process"',
    { "portal/server/x.ts": 'import p from "process";\nexport const a = p.env.A;\n' },
    [/env read/]
  ),
  must(
    S4,
    "function f({env} = process)",
    { "portal/server/x.ts": "export function f({ env } = process) {\n  return env.A;\n}\n" },
    [/env read/]
  ),
  must(
    S4,
    "const {process: {env}} = globalThis",
    { "portal/server/x.ts": "const { process: { env } } = globalThis;\nexport const a = env.A;\n" },
    [/env read/]
  ),
  must(
    S4,
    "const {process: p} = globalThis; p.env",
    { "portal/server/x.ts": "const { process: p } = globalThis;\nexport const a = p.env.A;\n" },
    [/env read/]
  ),
  must(
    S4,
    "({env} = process) as an assignment",
    { "portal/server/x.ts": "let env: any;\n({ env } = process);\nexport { env };\n" },
    [/env read/]
  ),
  must(
    S4,
    "process.env in .js, .cjs, .jsx, .mts and .cts files",
    {
      "tools/cli/src/a.js": "export const a = process.env.A;\n",
      "tools/cli/src/b.cjs": "module.exports = process.env.A;\n",
      "tools/cli/src/c.jsx": "export const a = process.env.A;\n",
      "tools/cli/src/d.mts": "export const a = process.env.A;\n",
      "tools/cli/src/e.cts": "export const a = process.env.A;\n"
    },
    [/a\.js is new/, /b\.cjs is new/, /c\.jsx is new/, /d\.mts is new/, /e\.cts is new/]
  ),
  pass(S4, "a local named process or p that is not the process object", {
    "portal/server/x.ts":
      "export function f(p: { env: string }, other: { process: { env: string } }) {\n  const q = other;\n  return p.env + q.process.env;\n}\n"
  }),
  pass(S4, "vitest.config.ts", { "portal/vitest.config.ts": "export default { env: process.env };\n" }),
  pass(S4, "a vitest-setup file", { "portal/vitest-setup.ts": "process.env.A = 'x';\n" }),
  pass(S4, "a *-harness.ts that imports vitest", {
    "platform/database/src/state-store-harness.ts":
      'import { beforeAll } from "vitest";\nbeforeAll(() => { process.env.A = "x"; });\n'
  }),
  pass(S4, "a test file and a file under a test folder", {
    "portal/server/x.test.ts": "export const a = process.env.A;\n",
    "portal/server/test/y.ts": "export const a = process.env.A;\n"
  }),
  pass(S4, "the per-process config modules", {
    "portal/server/host/config.ts": "export const a = process.env.A;\n",
    "engine/worker/src/config.ts": "export const a = process.env.A;\n",
    "integrations/outbound-proxy/src/host/env.ts": "export const a = process.env.A;\n",
    "tools/cli/src/config.ts": "export const a = process.env.A;\n",
    "engine/service/src/config.ts": "export const a = process.env.A;\n",
    "platform/database/src/config.ts": "export const a = process.env.A;\n"
  }),
  pass(S4, "the portal client folders and page and layout files (not server-side)", {
    "portal/features/a.ts": "export const a = process.env.A;\n",
    "portal/components/a.ts": "export const a = import.meta.env.A;\n",
    "portal/state/a.ts": "export const a = process.env.A;\n",
    "portal/shared/a.ts": "export const a = process.env.A;\n",
    "portal/app/page.tsx": "export default function P() { return process.env.A; }\n",
    "portal/app/layout.tsx": "export default function L() { return process.env.A; }\n"
  }),
  pass(S4, "process.env in a comment, a string and a different object", {
    "portal/server/x.ts":
      '// process.env.A\nexport const s = "process.env.A";\nexport const t = `import.meta.env`;\nexport const u = settings.env;\n'
  }),
  pass(S4, "a local named env and a process shadow-free read of other keys", {
    "portal/server/x.ts": "export function f(env: Record<string, string>) {\n  return env.A + process.cwd();\n}\n"
  }),

  // ---- S5: module-level let and var
  must(
    S5,
    "a top-level let in a new server file",
    { "portal/server/x.ts": "let counter = 0;\nexport const inc = () => (counter += 1);\n" },
    [/portal\/server\/x\.ts is new .*1 module-level let\/var declaration.*line 1.*boot/s]
  ),
  must(S5, "export let", { "portal/server/x.ts": "export let current = 0;\n" }, [/module-level/]),
  must(S5, "a top-level var", { "engine/core/src/x.ts": "var cache;\nexport const get = () => cache;\n" }, [
    /engine\/core\/src\/x\.ts is new/
  ]),
  must(
    S5,
    "two declarators in one statement count twice",
    { "portal/server/x.ts": "let a = 1, b = 2;\nexport const s = a + b;\n" },
    [/2 module-level/]
  ),
  must(
    S5,
    "a top-level let in boot.ts read through an exported getter (boot modules are not exempt)",
    {
      "portal/server/boot.ts":
        "let context: object | undefined;\nexport function current() {\n  return context;\n}\nexport function boot() {\n  context = Object.freeze({});\n}\n"
    },
    [/portal\/server\/boot\.ts is new .*1 module-level let\/var declaration/s, /frozen context/]
  ),
  pass(S5, "const, a function-local let, a class field and a for-loop let", {
    "portal/server/x.ts":
      "export const a = 1;\nexport function f() {\n  let n = 0;\n  n += 1;\n  return n;\n}\nexport class C {\n  static count = 0;\n}\nfor (let i = 0; i < 2; i += 1) f();\n"
  }),
  pass(S5, "a let in the portal client folders", {
    "portal/features/a.ts": "export let a = 1;\n",
    "portal/components/a.ts": "export let a = 1;\n",
    "portal/state/a.ts": "export let a = 1;\n",
    "portal/shared/a.ts": "export let a = 1;\n",
    "portal/app/page.tsx": "let a = 1;\nexport default function P() { return a; }\n"
  }),
  pass(S5, "a let in a test file, a vitest config and a harness that imports vitest", {
    "portal/server/x.test.ts": "let a = 1;\nexport { a };\n",
    "portal/vitest.config.ts": "let a = 1;\nexport default { a };\n",
    "platform/database/src/state-store-harness.ts":
      'import { vi } from "vitest";\nlet a = 1;\nexport const v = [vi, a];\n'
  }),
  pass(S5, "an ambient declare let", { "portal/server/x.ts": "declare let ambient: number;\nexport const a = 1;\n" }),

  // ---- S5b: module-level snapshots of a registry
  must(
    S5,
    "a top-level const IDS = intervalCalendarSourceIds()",
    {
      "engine/worker/src/x.ts":
        'import { intervalCalendarSourceIds } from "@x/contracts";\nconst IDS = intervalCalendarSourceIds();\nexport { IDS };\n'
    },
    [
      /engine\/worker\/src\/x\.ts is new .*1 module-level registry snapshot.*line 2.*intervalCalendarSourceIds\(\)/s,
      /function/
    ],
    {
      metric: "snapshots"
    }
  ),
  must(
    S5,
    "an exported const filled from connectionRegistry().flatMap(...)",
    {
      "portal/server/x.ts":
        "export const KNOWN: readonly string[] = connectionRegistry().flatMap((m) => (m.id ? [m.id] : []));\n"
    },
    [/registry snapshot/],
    { metric: "snapshots" }
  ),
  must(
    S5,
    "an IIFE const that reads calendarSourceConnections()",
    {
      "engine/worker/src/x.ts":
        "const S = (() => {\n  for (const m of calendarSourceConnections()) {\n    if (m.id) return m;\n  }\n  return null;\n})();\nexport { S };\n"
    },
    [/registry snapshot/],
    { metric: "snapshots" }
  ),
  must(
    S5,
    "a snapshot in a portal client file (S5b covers client files)",
    {
      "portal/components/x.ts": 'const sink = calendarSinkConnection()?.id ?? "";\nexport { sink };\n'
    },
    [/portal\/components\/x\.ts is new/],
    { metric: "snapshots" }
  ),
  must(
    S5,
    "Object.keys of an object a registry extends",
    {
      "platform/contracts/src/x.ts": "export const NAMES: readonly string[] = Object.keys(ACTIVITY_SOURCES);\n"
    },
    [/Object\.keys\(ACTIVITY_SOURCES\)/],
    { metric: "snapshots" }
  ),
  must(
    S5,
    "Object.values and Object.entries of an extended object",
    {
      "platform/contracts/src/x.ts":
        "export const A = Object.values(ACTIVITY_SOURCES);\nexport const B = Object.entries(ACTIVITY_SOURCES);\n"
    },
    [/2 module-level registry snapshots/],
    { metric: "snapshots" }
  ),
  pass(
    S5,
    "a registry read inside a function, an arrow, a method and a callback",
    {
      "portal/server/x.ts":
        "export function ids() {\n  return intervalCalendarSourceIds();\n}\nexport const lazy = () => connectionRegistry();\nexport const cb = [1].map(() => calendarSinkConnection());\nexport class K {\n  all = () => calendarSourceIds();\n  get names() {\n    return Object.keys(ACTIVITY_SOURCES);\n  }\n}\n"
    },
    { metric: "snapshots" }
  ),
  pass(
    S5,
    "Object.keys of an object no registry extends, and a call with a registry-like name on another receiver",
    {
      "portal/server/x.ts":
        "export const K = Object.keys({ a: 1 });\nexport const L = Object.values(OTHER);\nexport const M = other.connectionRegistry;\n"
    },
    { metric: "snapshots" }
  ),
  pass(
    S5,
    "a snapshot in a test file",
    { "portal/server/x.test.ts": "const IDS = intervalCalendarSourceIds();\nexport { IDS };\n" },
    { metric: "snapshots" }
  ),
  pass(
    S5,
    "the registry definition itself (a function that reads module state is not a snapshot)",
    {
      "platform/contracts/src/connections/registry.ts":
        "export function connectionRegistry() {\n  return [];\n}\nexport function calendarSourceIds() {\n  return connectionRegistry().map((m) => m.id);\n}\n"
    },
    { metric: "snapshots" }
  )
];

// ----------------------------------------------------------------- ratchet behaviours, the same for every rule
// `at` is the lane's file; `H` is the lane of portal/server/**, `T` of tools/rhen-watch/**.
const HOME = (rule) => RULES[rule].file;
const OTHER_LANE_FILE = "tools/rhen-watch/src/y.ts";

export function ratchetCases(rule) {
  const { metric } = RULES[rule];
  const file = HOME(rule);
  const sample = SAMPLE[rule];
  const baseFiles = { [file]: hits(rule, 2), "portal/server/clean.ts": sample.clean };
  const baseShards = { H: shard("H", metric, { [file]: 2 }) };
  const dir = `scripts/repository/pending/${rule}`;
  return [
    {
      name: "the shard matches the measured counts",
      base: baseFiles,
      baseShards
    },
    {
      name: "a raised count in a file",
      base: baseFiles,
      baseShards,
      files: { [file]: hits(rule, 3) },
      expect: [new RegExp(`${file} has 3 .*${dir}/H\\.json allows 2`, "s")]
    },
    {
      name: "a raised count with its shard edited up too (the lane total rises)",
      base: baseFiles,
      baseShards,
      files: { [file]: hits(rule, 3) },
      shards: { H: shard("H", metric, { [file]: 3 }) },
      expect: [/Lane H .* total rises from 2 \(at base\) to 3/]
    },
    {
      name: "a stale count (the shard is higher than measured)",
      base: baseFiles,
      baseShards,
      files: { [file]: hits(rule, 1) },
      expect: [new RegExp(`${file} now has 1 .*below the 2 in ${dir}/H\\.json.*--fix-pending`, "s")]
    },
    {
      name: "a deleted file whose shard entry stays",
      base: baseFiles,
      baseShards,
      files: { [file]: null },
      expect: [new RegExp(`${file} now has 0 .*below the 2`, "s")]
    },
    {
      name: "a new file with a hit",
      base: baseFiles,
      baseShards,
      files: { "portal/server/new.ts": hits(rule, 1) },
      expect: [/portal\/server\/new\.ts is new/, /--fix-pending/]
    },
    {
      name: "two hits move to a new file in the same lane and the lane total stays level (no git rename)",
      base: baseFiles,
      baseShards,
      files: { [file]: hits(rule, 1), "portal/server/moved.ts": hits(rule, 1) },
      shards: { H: shard("H", metric, { [file]: 1, "portal/server/moved.ts": 1 }) }
    },
    {
      name: "hits split out of a file into a new file in a different lane (the other lane's total rises)",
      base: baseFiles,
      baseShards,
      files: { [file]: hits(rule, 1), [OTHER_LANE_FILE]: hits(rule, 1) },
      shards: { H: shard("H", metric, { [file]: 1 }), T: shard("T", metric, { [OTHER_LANE_FILE]: 1 }) },
      expect: [/Lane T .* total rises from 0 \(at base\) to 1/]
    },
    {
      name: "a hit in a lane that had none",
      base: baseFiles,
      baseShards,
      files: { [OTHER_LANE_FILE]: hits(rule, 1) },
      shards: { H: baseShards.H, T: shard("T", metric, { [OTHER_LANE_FILE]: 1 }) },
      expect: [/Lane T .* total rises from 0 \(at base\) to 1/]
    },
    {
      name: "a shard whose total is not the sum of its files",
      base: baseFiles,
      baseShards,
      shards: { H: { lane: "H", [metric]: { total: 5, files: { [file]: 2 } } } },
      expect: [/total is 5 but its files add up to 2/]
    },
    {
      name: "a shard filed under the wrong lane",
      base: baseFiles,
      baseShards,
      shards: { H: baseShards.H, T: shard("T", metric, { [file]: 2 }) },
      expect: [/lists portal\/server\/x\.ts, which belongs to lane H/]
    },
    {
      name: "the rule did not exist at the base (bootstrap): seeding the shards passes",
      base: baseFiles,
      baseShards: {},
      shards: baseShards
    },
    {
      name: "the rule did not exist at the base: a hit with no shard still fails",
      base: baseFiles,
      baseShards: {},
      shards: {},
      expect: [new RegExp(`${file} is new`)]
    },
    {
      name: "the composed tree (no HEAD, .sync-core.json): overlay, patched and generated files are skipped",
      composed: true,
      base: {
        [file]: sample.clean,
        "portal/server/overlay.ts": hits(rule, 2),
        "portal/server/patched.ts": hits(rule, 2),
        "portal/server/generated.ts": hits(rule, 2),
        ".sync-core.json": JSON.stringify({
          overlayFiles: ["portal/server/overlay.ts"],
          patchedFiles: { "portal/server/patched.ts": ["x"] },
          generatedFiles: ["portal/server/generated.ts"]
        })
      }
    },
    {
      name: "the composed tree still counts a core file",
      composed: true,
      base: { [file]: hits(rule, 1), ".sync-core.json": JSON.stringify({ overlayFiles: [] }) },
      expect: [new RegExp(`${file} is new`)]
    }
  ];
}
