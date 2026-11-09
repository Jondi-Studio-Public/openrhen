// Seam inventory (modularity plan A3; metrics C5 and S2). A registry is found by what it does, not by what it is called:
// any exported function, or exported const holding an arrow or function expression, whose body changes a module-level
// collection (`.set`, `.add`, `.push`, `.splice`, `delete`, an index assignment, or `Object.assign` on a top-level
// binding), directly or through a helper in the same file. Renaming `registerX` to `attach` does not dodge it.
//
// A registry passes when it is built on `createRegistry` (platform/contracts/src/extension/registry.ts) with a `@seam`
// tag on its declaration, or carries the `@seam` tag itself, or is listed `pending` in a per-lane shard under
// scripts/repository/pending/seam-inventory/<lane>.json. The shards only shrink and are deleted at zero. Lane
// assignment, the base comparison, the non-git (composed tree) handling and `--fix-pending` follow vendor-terms.mjs,
// whose helpers this file reuses.
//
// The same scan writes docs/protocol/seams.generated.json (a static list of {name, module, key} for every
// `createRegistry` call; the composed duplicate-key suites of slice A8 read it) and seams.generated.md. A test fails
// when either file is stale. Regenerate with `pnpm seams:generate`.
//
// Rule-shaped entry: `checkInventory(ctx) => string[]` with ctx = { root, args?, base?, env? }. It is not in rules/ (the
// loader would run it on every structure check); scripts/test/seam-inventory.test.mjs is the guard.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lineOf, parse, walk } from "./rules/ast.mjs";
import {
  composedSkips,
  gitOk,
  hasHead,
  isTest,
  laneOf,
  readJson,
  resolveBase,
  showAtBase,
  trackedFiles
} from "./rules/vendor-terms.mjs";

const CONFIG = "scripts/repository/rules/vendor-terms.json";
const PENDING = "scripts/repository/pending/seam-inventory";
const GENERATED_JSON = "docs/protocol/seams.generated.json";
const GENERATED_MD = "docs/protocol/seams.generated.md";
const FIX = "run `pnpm seams:generate`";
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Test code that is not named *.test.*: harnesses and test-support modules.
const TEST_SUPPORT = /(?:-harness|-test-support)\.[cm]?[jt]sx?$/;
const MUTATING_METHODS = new Set(["set", "add", "push", "splice"]);
// Cheap text filter so only files that could hold a registry or a createRegistry call are parsed.
const MAY_MATCH = /\.\s*(?:set|add|push|splice)\s*\(|\bdelete\b|Object\s*\.\s*assign|\]\s*=(?!=)|createRegistry/;

const WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ParenthesizedExpression",
  "ChainExpression"
]);
const unwrap = (node) => {
  let current = node;
  while (current && WRAPPERS.has(current.type)) current = current.expression;
  return current;
};

// The identifier a member/call chain starts from: `a.b[c].get(d)!` -> a.
function rootName(node) {
  let current = unwrap(node);
  for (;;) {
    if (!current) return null;
    if (current.type === "Identifier") return current.name;
    if (current.type === "MemberExpression") current = unwrap(current.object);
    else if (current.type === "CallExpression") current = unwrap(current.callee);
    else return null;
  }
}

function patternNames(node, out) {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      out.add(node.name);
      break;
    case "ObjectPattern":
      for (const property of node.properties)
        patternNames(property.type === "RestElement" ? property.argument : property.value, out);
      break;
    case "ArrayPattern":
      for (const element of node.elements) patternNames(element, out);
      break;
    case "AssignmentPattern":
      patternNames(node.left, out);
      break;
    case "RestElement":
      patternNames(node.argument, out);
      break;
    case "TSParameterProperty":
      patternNames(node.parameter, out);
      break;
    default:
  }
}

const isFunction = (node) =>
  node &&
  (node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression");

// Every name declared anywhere inside a function (parameters, locals, nested functions, catch parameters). A name
// declared inside shadows a module binding of the same name, so a write to it is not a write to the module's collection.
function declaredInside(fn) {
  const names = new Set();
  for (const param of fn.params ?? []) patternNames(param, names);
  walk(fn.body, (node) => {
    if (node.type === "VariableDeclarator") patternNames(node.id, names);
    else if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id)
      names.add(node.id.name);
    else if (node.type === "CatchClause") patternNames(node.param, names);
    if (isFunction(node)) for (const param of node.params ?? []) patternNames(param, names);
  });
  return names;
}

// What a function body does to the module: which top-level bindings it writes and which top-level functions it calls.
function effectsOf(fn, topLevel, functions) {
  const shadowed = declaredInside(fn);
  const collection = (node) => {
    const name = rootName(node);
    return name !== null && topLevel.has(name) && !shadowed.has(name);
  };
  let writes = false;
  const calls = new Set();
  walk(fn.body, (node) => {
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      if (callee?.type === "MemberExpression" && !callee.computed && MUTATING_METHODS.has(callee.property.name)) {
        if (collection(callee.object)) writes = true;
      } else if (
        callee?.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "Object" &&
        callee.property.name === "assign" &&
        node.arguments[0] &&
        collection(node.arguments[0])
      ) {
        writes = true;
      } else if (callee?.type === "Identifier" && functions.has(callee.name) && !shadowed.has(callee.name))
        calls.add(callee.name);
    } else if (node.type === "AssignmentExpression") {
      const left = unwrap(node.left);
      if (left?.type === "MemberExpression" && left.computed && collection(left.object)) writes = true;
    } else if (node.type === "UnaryExpression" && node.operator === "delete") {
      const target = unwrap(node.argument);
      if (target?.type === "MemberExpression" && collection(target.object)) writes = true;
    }
  });
  return { writes, calls };
}

// True when the comment run directly above `statement` (only whitespace between) holds a `@seam` tag.
function seamTagged(parsed, statement) {
  const { source, comments } = parsed;
  let cursor = statement.start;
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const comment = comments[i];
    if (comment.end > cursor) continue;
    if (source.slice(comment.end, cursor).trim() !== "") break;
    if (/@seam\b/.test(comment.value)) return true;
    cursor = comment.start;
  }
  return false;
}

const literalString = (node) => {
  const value = unwrap(node);
  if (value?.type === "Literal" && typeof value.value === "string") return value.value;
  if (value?.type === "TemplateLiteral" && value.expressions.length === 0 && value.quasis.length === 1)
    return value.quasis[0].value.cooked;
  return null;
};

// scanSource(file, source?) -> { registries: [{name, line}], seams: [{name, module, key}], errors }.
export function scanSource(file, source) {
  const parsed = parse(file, source);
  const { body } = parsed;
  const errors = [];

  // Top-level collections and functions, with the statement each sits in (for the @seam tag).
  const topLevel = new Set();
  const functions = new Map(); // local name -> { node, statement }
  const noteVariable = (declaration, statement) => {
    for (const declarator of declaration.declarations) {
      patternNames(declarator.id, topLevel);
      const init = unwrap(declarator.init);
      if (declarator.id.type === "Identifier" && isFunction(init))
        functions.set(declarator.id.name, { node: init, statement });
    }
  };
  const exported = []; // { exportedName, local, statement }
  for (const statement of body) {
    const inner =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (inner?.type === "VariableDeclaration") {
      noteVariable(inner, statement);
      if (statement.type === "ExportNamedDeclaration")
        for (const declarator of inner.declarations)
          if (declarator.id.type === "Identifier" && functions.has(declarator.id.name))
            exported.push({ exportedName: declarator.id.name, local: declarator.id.name, statement });
    } else if (inner?.type === "FunctionDeclaration" && inner.id) {
      functions.set(inner.id.name, { node: inner, statement });
      if (statement.type === "ExportNamedDeclaration")
        exported.push({ exportedName: inner.id.name, local: inner.id.name, statement });
      else if (statement.type === "ExportDefaultDeclaration")
        exported.push({ exportedName: "default", local: inner.id.name, statement });
    } else if (statement.type === "ExportDefaultDeclaration" && isFunction(inner)) {
      // An anonymous default function: analysed under a synthetic name.
      functions.set("default", { node: inner, statement });
      exported.push({ exportedName: "default", local: "default", statement });
    }
  }
  for (const statement of body) {
    if (statement.type === "ExportNamedDeclaration" && !statement.declaration && !statement.source) {
      for (const specifier of statement.specifiers) {
        const local = specifier.local.name;
        if (functions.has(local))
          exported.push({
            exportedName: specifier.exported.name ?? specifier.exported.value,
            local,
            statement: functions.get(local).statement
          });
      }
    } else if (statement.type === "ExportDefaultDeclaration" && statement.declaration?.type === "Identifier") {
      const local = statement.declaration.name;
      if (functions.has(local))
        exported.push({ exportedName: "default", local, statement: functions.get(local).statement });
    }
  }

  // Which functions write a module-level collection, directly or through the helpers they call.
  const effects = new Map([...functions].map(([name, { node }]) => [name, effectsOf(node, topLevel, functions)]));
  const writes = new Map([...effects].map(([name, effect]) => [name, effect.writes]));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, effect] of effects) {
      if (writes.get(name)) continue;
      if ([...effect.calls].some((callee) => writes.get(callee))) {
        writes.set(name, true);
        changed = true;
      }
    }
  }

  const registries = [];
  const seen = new Set();
  for (const { exportedName, local, statement } of exported) {
    if (!writes.get(local) || seen.has(exportedName)) continue;
    seen.add(exportedName);
    if (seamTagged(parsed, statement)) continue;
    registries.push({ name: exportedName, line: lineOf(parsed.source, functions.get(local).node) });
  }

  // createRegistry calls: each needs a literal name and key and a @seam tag on the statement that holds it.
  const seams = [];
  for (const statement of body) {
    walk(statement, (node) => {
      if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== "createRegistry")
        return;
      const where = `${file}:${lineOf(parsed.source, node)}`;
      const options = unwrap(node.arguments[0]);
      const field = (name) =>
        options?.type === "ObjectExpression"
          ? literalString(
              options.properties.find(
                (property) => property.type === "Property" && (property.key.name ?? property.key.value) === name
              )?.value
            )
          : null;
      const name = field("name");
      const key = field("key");
      if (name === null || key === null) {
        errors.push(
          `${where} calls createRegistry without a literal name and key. The seam list is generated from the source, so both must be string literals.`
        );
        return;
      }
      if (!seamTagged(parsed, statement)) {
        errors.push(
          `${where} builds the registry "${name}" with createRegistry but its declaration has no @seam tag. Add a /** ... @seam */ comment directly above it.`
        );
        return;
      }
      seams.push({ name, module: file, key });
    });
  }
  return { registries, seams, errors };
}

// scanTree(root) -> { registries: Map(path -> [{name, line}]), seams, errors } over the tracked, non-test source files.
export function scanTree(root, { skip = new Set() } = {}) {
  const registries = new Map();
  const seams = [];
  const errors = [];
  for (const path of trackedFiles(root)) {
    if (skip.has(path) || !SOURCE.test(path) || path.endsWith(".d.ts") || isTest(path) || TEST_SUPPORT.test(path))
      continue;
    let text;
    try {
      text = readFileSync(resolve(root, path), "utf8");
    } catch {
      continue;
    }
    if (!MAY_MATCH.test(text)) continue;
    const found = scanSource(path, text);
    if (found.registries.length) registries.set(path, found.registries);
    seams.push(...found.seams);
    errors.push(...found.errors);
  }
  seams.sort((a, b) => (a.name === b.name ? (a.module < b.module ? -1 : 1) : a.name < b.name ? -1 : 1));
  return { registries, seams, errors };
}

function readShards(root) {
  const dir = resolve(root, PENDING);
  const shards = new Map();
  if (!existsSync(dir)) return shards;
  for (const name of readdirSync(dir).sort()) {
    if (name.endsWith(".json")) shards.set(name.slice(0, -5), JSON.parse(readFileSync(join(dir, name), "utf8")));
  }
  return shards;
}

function baseShards(root, base) {
  const listed = gitOk(root, ["ls-tree", "-r", "--name-only", base, "--", PENDING]);
  if (listed === null || !listed.trim()) return null; // the rule did not exist at the base: bootstrap
  const shards = new Map();
  for (const file of listed.split("\n").filter((line) => line.endsWith(".json"))) {
    shards.set(file.split("/").pop().slice(0, -5), JSON.parse(showAtBase(root, base, file)));
  }
  return shards;
}

const totalOf = (shards, lane) => shards?.get(lane)?.registries?.total ?? 0;
const sorted = (list) => [...list].sort();

// lane -> { total, files: {path: [names]} } of what the tree holds now.
function measureLanes(config, registries) {
  const lanes = new Map();
  for (const [path, found] of [...registries].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const lane = laneOf(config, path);
    const entry = lanes.get(lane) ?? { total: 0, files: {} };
    entry.files[path] = sorted(found.map((registry) => registry.name));
    entry.total += found.length;
    lanes.set(lane, entry);
  }
  return lanes;
}

export function checkInventory(ctx) {
  const root = ctx.root;
  const args = ctx.args ?? [];
  const errors = [];
  if (!existsSync(resolve(root, CONFIG)))
    return [`${CONFIG} is missing. It holds the lane patterns the shards use; restore it.`];
  const config = readJson(root, CONFIG);
  const head = hasHead(root);
  const base = resolveBase(root, ctx);
  const ci = ctx.env?.CI ?? process.env.CI;
  if (!base && head && ci) {
    errors.push(
      "The commit to compare against could not be found, so the lane-total check cannot run, and CI must not skip it. Fetch more history (for example `fetch-depth: 2` or `git fetch origin main`) or set VENDOR_TERMS_BASE to a commit that exists."
    );
  } else if (!base && head) {
    console.warn(
      "seam-inventory: no base commit found, so the lane-total comparison was skipped (fetch origin/main or set VENDOR_TERMS_BASE to run it)."
    );
  }

  const scan = scanTree(root, { skip: composedSkips(root) });
  errors.push(...scan.errors);
  const measured = measureLanes(config, scan.registries);
  let shards = readShards(root);
  const bShards = base ? baseShards(root, base) : null;

  if (args.includes("--fix-pending")) {
    // Rewrite every lane to the measured entries, but never raise a lane total above what it was at the base.
    const cap = (lane) => (bShards ? totalOf(bShards, lane) : shards.size ? totalOf(shards, lane) : Infinity);
    const dir = resolve(root, PENDING);
    mkdirSync(dir, { recursive: true });
    for (const lane of new Set([...measured.keys(), ...shards.keys()])) {
      const now = measured.get(lane);
      const file = join(dir, `${lane}.json`);
      if (now && now.total > cap(lane)) {
        errors.push(
          `Refusing to raise ${lane} from ${cap(lane)} to ${now.total}: pending counts only shrink. Put the new registry on createRegistry with a @seam tag, or move it from a file in the same lane.`
        );
      } else if (now) writeFileSync(file, `${JSON.stringify({ lane, registries: now }, null, 2)}\n`);
      else rmSync(file, { force: true });
    }
    shards = readShards(root);
  }

  for (const [lane, shard] of shards) {
    if (shard.lane !== lane)
      errors.push(`${PENDING}/${lane}.json says lane "${shard.lane}"; the file name and the lane must match.`);
  }
  for (const lane of [...new Set([...measured.keys(), ...shards.keys()])].sort()) {
    const shardFile = `${PENDING}/${lane}.json`;
    const now = measured.get(lane)?.files ?? {};
    const declared = shards.get(lane)?.registries;
    const declaredFiles = declared?.files ?? {};
    if (declared) {
      const sum = Object.values(declaredFiles).reduce((total, list) => total + list.length, 0);
      if (sum !== declared.total)
        errors.push(`${shardFile}: total is ${declared.total} but its files add up to ${sum}. ${FIX}.`);
    }
    for (const path of new Set([...Object.keys(now), ...Object.keys(declaredFiles)])) {
      const have = new Set(now[path] ?? []);
      const pending = new Set(declaredFiles[path] ?? []);
      for (const name of have) {
        if (pending.has(name)) continue;
        const line = scan.registries.get(path)?.find((registry) => registry.name === name)?.line ?? 1;
        errors.push(
          `${path}:${line} exports ${name}, which changes a module-level collection (a registry) and is not pending, @seam tagged or on createRegistry. Build it on createRegistry from @openrhen/contracts/extension and put a @seam tag on its declaration. If it moved here from another file in lane ${lane} and the lane total did not rise, ${FIX}.`
        );
      }
      for (const name of pending) {
        if (!have.has(name))
          errors.push(
            `${path} is stale in ${shardFile}: it no longer exports the registry ${name} (moved, tagged or removed). Remove the entry, or ${FIX}.`
          );
      }
      if (declaredFiles[path] !== undefined && laneOf(config, path) !== lane)
        errors.push(
          `${shardFile} lists ${path}, which belongs to lane ${laneOf(config, path)}. Move the entry, or ${FIX}.`
        );
    }
    if (bShards) {
      const before = totalOf(bShards, lane);
      const after = declared?.total ?? 0;
      if (after > before)
        errors.push(
          `Lane ${lane} registries total rises from ${before} (at ${base}) to ${after}. A lane total never rises in a pull request: build the new registry on createRegistry with a @seam tag instead of adding it to the pending list.`
        );
    }
  }
  return [...new Set(errors)];
}

// The generated seam list, a pure function of the tree.
export function renderGenerated(root) {
  const scan = scanTree(root, { skip: composedSkips(root) });
  const json = `${JSON.stringify(scan.seams, null, 2)}\n`;
  const config = existsSync(resolve(root, CONFIG)) ? readJson(root, CONFIG) : null;
  const lines = [
    "# Seam list (generated)",
    "",
    "<!-- Generated by scripts/repository/seam-inventory.mjs; do not edit. Regenerate with `pnpm seams:generate`. -->",
    "",
    "Every registry core holds for add-ons to fill, from the source. A registry built on `createRegistry` (`@openrhen/contracts/extension`) refuses a duplicate key, names both owners, and is listed under Registries with its name, module and key. Anything else that fills a module-level collection is pending: it is counted under Pending until it moves onto `createRegistry`. The machine-readable form of the first list is [seams.generated.json](seams.generated.json); the seams and their tests are described in the [protocol](README.md).",
    "",
    "## Registries",
    ""
  ];
  if (scan.seams.length === 0) lines.push("None yet: no registry is on `createRegistry`.", "");
  else {
    lines.push("| Name | Module | Key |", "|---|---|---|");
    for (const seam of scan.seams) lines.push(`| ${seam.name} | \`${seam.module}\` | ${seam.key} |`);
    lines.push("");
  }
  const total = [...scan.registries.values()].reduce((sum, list) => sum + list.length, 0);
  lines.push(
    "## Pending",
    "",
    `${total} registries in ${scan.registries.size} files still fill a module-level collection directly. The list, per file and lane, is in \`scripts/repository/pending/seam-inventory/\`; it only shrinks, and a registry leaves it when it moves onto \`createRegistry\`.`,
    ""
  );
  if (total > 0 && config) {
    const lanes = measureLanes(config, scan.registries);
    lines.push("| Lane | Files | Registries |", "|---|---|---|");
    for (const [lane, entry] of [...lanes].sort(([a], [b]) => (a < b ? -1 : 1)))
      lines.push(`| ${lane} | ${Object.keys(entry.files).length} | ${entry.total} |`);
    lines.push("");
  }
  return { json, md: `${lines.join("\n")}` };
}

export function checkGenerated(ctx) {
  const { json, md } = renderGenerated(ctx.root);
  const errors = [];
  for (const [file, expected] of [
    [GENERATED_JSON, json],
    [GENERATED_MD, md]
  ]) {
    const path = resolve(ctx.root, file);
    const current = existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== expected)
      errors.push(
        `${file} is ${current === null ? "missing" : "stale"}: it no longer matches the registries in the source. ${FIX}.`
      );
  }
  return errors;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const args = process.argv.slice(2);
  const errors = checkInventory({ root, args: args.includes("--fix-pending") ? ["--fix-pending"] : [] });
  if (args.includes("--generate")) {
    const { json, md } = renderGenerated(root);
    mkdirSync(resolve(root, "docs/protocol"), { recursive: true });
    writeFileSync(resolve(root, GENERATED_JSON), json);
    writeFileSync(resolve(root, GENERATED_MD), md);
  }
  if (errors.length) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
