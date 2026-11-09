// Env-reader ratchet (modularity plan A2, metric S4). Config is read once, in one config module per process, and
// handed to everything else as a value. This rule counts every env read in a server-side maintained source file:
//   `process.env`, `process["env"]`, `globalThis.process.env`, `import.meta.env`, a destructured `const { env } = process`,
//   and `import { env } from "node:process"`,
// whatever it is used for (so `export const env = process.env` and a default argument `env = process.env` are reads).
// Allowed homes: the per-process config modules (CONFIG_MODULES). Tests and test support (`*.test.*`, `/test/`,
// `*.config.ts`, `vitest-*.ts`, any file that imports vitest) are not read. Portal client folders and page and layout
// files are not server-side. Everything else is held to a per-lane pending shard
// (scripts/repository/pending/env-readers/<lane>.json) that only shrinks. See shared-state-ratchet.mjs.
import { walk } from "./ast.mjs";
import { CONFIG_MODULES, astRatchet } from "../shared-state-ratchet.mjs";

const ADVICE = `Do not read env here. Add the value to the process's config module (${CONFIG_MODULES.join(", ")}) and have this file take it as a parameter or from the config object. Those modules are the only allowed home.`;

const keyOf = (node) =>
  node && (node.type === "Identifier" ? node.name : node.type === "Literal" ? node.value : undefined);
// `process` or `globalThis.process`
const isProcess = (node) =>
  (node?.type === "Identifier" && node.name === "process") ||
  (node?.type === "MemberExpression" &&
    node.object?.type === "Identifier" &&
    node.object.name === "globalThis" &&
    keyOf(node.property) === "process" &&
    (!node.computed || node.property.type === "Literal"));

function measure({ path, parsed, server }) {
  if (!server || CONFIG_MODULES.includes(path)) return {};
  const found = [];
  for (const statement of parsed.body) {
    if (
      statement.type === "ImportDeclaration" &&
      /^(?:node:)?process$/.test(statement.source.value) &&
      statement.specifiers.some(
        (specifier) => specifier.type === "ImportSpecifier" && keyOf(specifier.imported) === "env"
      )
    )
      found.push({ start: statement.start, what: `import { env } from "${statement.source.value}"` });
  }
  for (const statement of parsed.body) {
    walk(statement, (node) => {
      if (node.type === "MemberExpression") {
        const name = node.computed
          ? node.property.type === "Literal"
            ? node.property.value
            : undefined
          : node.property?.name;
        if (name === "env" && isProcess(node.object)) found.push({ start: node.start, what: "process.env" });
        else if (
          name === "env" &&
          node.object?.type === "MetaProperty" &&
          node.object.meta.name === "import" &&
          node.object.property.name === "meta"
        )
          found.push({ start: node.start, what: "import.meta.env" });
      } else if (node.type === "VariableDeclarator" && node.id?.type === "ObjectPattern" && isProcess(node.init)) {
        if (node.id.properties.some((property) => property.type === "Property" && keyOf(property.key) === "env"))
          found.push({ start: node.start, what: "const { env } = process" });
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
