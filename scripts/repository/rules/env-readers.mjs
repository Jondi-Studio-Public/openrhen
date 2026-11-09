// Env-reader ratchet (modularity plan A2, metric S4). Config is read once, in one config module per process, and
// handed to everything else as a value. This rule counts every env read in a server-side maintained source file:
//   `process.env`, `process["env"]`, `globalThis.process.env`, `import.meta.env`, a destructured `const { env } = process`,
//   `import { env } from "node:process"`, and the same through an alias (`const p = process; p.env`, `import process from
//   "node:process"`, `function f({ env } = process)`, `const { process: { env } } = globalThis`, `(process as X).env`),
// whatever it is used for (so `export const env = process.env` and a default argument `env = process.env` are reads).
// Allowed homes: the per-process config modules (CONFIG_MODULES). Tests and test support (`*.test.*`, `/test/`,
// `*.config.ts`, `vitest-*.ts`, any file that imports vitest) are not read. Portal client folders and page and layout
// files are not server-side. Everything else is held to a per-lane pending shard
// (scripts/repository/pending/env-readers/<lane>.json) that only shrinks. See shared-state-ratchet.mjs.
import { walk } from "./ast.mjs";
import { CONFIG_MODULES, astRatchet, unwrap } from "../shared-state-ratchet.mjs";

const ADVICE = `Do not read env here. Add the value to the process's config module (${CONFIG_MODULES.join(", ")}) and have this file take it as a parameter or from the config object. Those modules are the only allowed home.`;

const keyOf = (node) =>
  node && (node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : undefined);
const memberName = (node) =>
  node.computed ? (node.property.type === "Literal" ? node.property.value : undefined) : node.property?.name;
const isProcessModule = (value) => /^(?:node:)?process$/.test(value);

// Names bound to `process` and to `globalThis` anywhere in the file (name-based, scope-blind: an alias in any scope
// makes that name suspect everywhere, which only over-counts).
function aliases(body) {
  const processNames = new Set(["process"]);
  const globalNames = new Set(["globalThis"]);
  const isGlobal = (node) => {
    const n = unwrap(node);
    return n?.type === "Identifier" && globalNames.has(n.name);
  };
  const isProc = (node) => {
    const n = unwrap(node);
    if (n?.type === "Identifier") return processNames.has(n.name);
    return n?.type === "MemberExpression" && isGlobal(n.object) && memberName(n) === "process";
  };
  const bind = (set, id) => {
    const target = id?.type === "AssignmentPattern" ? id.left : id;
    if (target?.type === "Identifier" && !set.has(target.name)) {
      set.add(target.name);
      return true;
    }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const statement of body) {
      walk(statement, (node) => {
        if (node.type === "ImportDeclaration" && isProcessModule(node.source.value)) {
          for (const specifier of node.specifiers) {
            if (specifier.type !== "ImportSpecifier" || keyOf(specifier.imported) === "default")
              changed = bind(processNames, specifier.local) || changed;
          }
        } else if (
          node.type === "VariableDeclarator" ||
          node.type === "AssignmentPattern" ||
          node.type === "AssignmentExpression"
        ) {
          const left = node.type === "VariableDeclarator" ? node.id : node.left;
          const right = node.type === "VariableDeclarator" ? node.init : node.right;
          if (!left || !right) return;
          if (left.type === "Identifier") {
            if (isProc(right)) changed = bind(processNames, left) || changed;
            else if (isGlobal(right)) changed = bind(globalNames, left) || changed;
          } else if (left.type === "ObjectPattern" && isGlobal(right)) {
            for (const property of left.properties)
              if (property.type === "Property" && keyOf(property.key) === "process")
                changed = bind(processNames, property.value) || changed;
          }
        }
      });
    }
  }
  return { isProc, isGlobal };
}

function measure({ path, parsed, server }) {
  if (!server || CONFIG_MODULES.includes(path)) return {};
  const found = [];
  const { isProc, isGlobal } = aliases(parsed.body);
  const hasEnv = (pattern) =>
    pattern.properties.some((property) => property.type === "Property" && keyOf(property.key) === "env");
  // A destructuring `pattern` that takes `env` out of `source` (process) or `process: { env }` out of globalThis.
  const destructures = (pattern, source) => {
    if (pattern?.type !== "ObjectPattern" || !source) return false;
    if (isProc(source)) return hasEnv(pattern);
    if (!isGlobal(source)) return false;
    return pattern.properties.some((property) => {
      if (property.type !== "Property" || keyOf(property.key) !== "process") return false;
      const value = property.value?.type === "AssignmentPattern" ? property.value.left : property.value;
      return value?.type === "ObjectPattern" && hasEnv(value);
    });
  };
  for (const statement of parsed.body) {
    if (
      statement.type === "ImportDeclaration" &&
      isProcessModule(statement.source.value) &&
      statement.specifiers.some(
        (specifier) => specifier.type === "ImportSpecifier" && keyOf(specifier.imported) === "env"
      )
    )
      found.push({ start: statement.start, what: `import { env } from "${statement.source.value}"` });
  }
  for (const statement of parsed.body) {
    walk(statement, (node) => {
      if (node.type === "MemberExpression") {
        if (memberName(node) !== "env") return;
        const object = unwrap(node.object);
        if (isProc(object)) found.push({ start: node.start, what: "process.env" });
        else if (object?.type === "MetaProperty" && object.meta.name === "import" && object.property.name === "meta")
          found.push({ start: node.start, what: "import.meta.env" });
      } else if (node.type === "VariableDeclarator") {
        if (destructures(node.id, node.init)) found.push({ start: node.start, what: "const { env } = process" });
      } else if (node.type === "AssignmentPattern" || node.type === "AssignmentExpression") {
        if (destructures(node.left, node.right)) found.push({ start: node.start, what: "{ env } = process" });
      }
    });
  }
  return { reads: found };
}

export default function envReaders(ctx) {
  return astRatchet(ctx, {
    rule: "env-readers",
    metrics: { reads: { noun: "env read", advice: ADVICE } },
    measure
  });
}
