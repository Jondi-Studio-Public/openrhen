// Module-load side-effect ratchet (modularity plan A2, metric S1). Importing a core module must not fill a registry,
// start a listener or change route policy. This rule counts, in every maintained source file (client files included):
//   - a bare `import "x"` (with or without a semicolon; `.css`, `server-only` and `client-only` are not side effects),
//   - a top-level `await import()`,
//   - a top-level `require()`,
//   - an eager `import.meta.glob(..., { eager: true })`, wherever it is written: the bundler hoists it into static
//     imports, so it is today's discovery side effect even inside a function.
// "Top-level" means it runs when the module loads: not inside a function body (an immediately invoked one counts).
// `**/boot.ts` is the composition root and may do these; every other file is held to a per-lane pending shard
// (scripts/repository/pending/side-effect-imports/<lane>.json) that only shrinks. See shared-state-ratchet.mjs.
import { walk } from "./ast.mjs";
import { astRatchet, walkModuleLoad } from "../shared-state-ratchet.mjs";

const ALLOWED_BARE = /\.css$|^(?:server-only|client-only)$/;
const isBoot = (path) => /(?:^|\/)boot\.ts$/.test(path);

const ADVICE =
  "A core module must not do work when it is imported. Move the registration into the boot function of the process's boot.ts (the one place that may import for effect) and call it from there, or import what you need by name and call it from boot(). Files named boot.ts are the only allowed home.";

function measure({ path, parsed }) {
  if (isBoot(path)) return {};
  const found = [];
  const isEagerGlob = (node) => {
    const callee = node.callee;
    if (callee?.type !== "MemberExpression" || callee.computed || callee.property.name !== "glob") return false;
    const meta = callee.object;
    if (meta?.type !== "MetaProperty" || meta.meta.name !== "import" || meta.property.name !== "meta") return false;
    const options = node.arguments[1];
    return (
      options?.type === "ObjectExpression" &&
      options.properties.some(
        (property) =>
          property.type === "Property" &&
          (property.key.name ?? property.key.value) === "eager" &&
          property.value.type === "Literal" &&
          property.value.value === true
      )
    );
  };
  for (const statement of parsed.body) {
    // `import "x"` has no specifiers, and so does `import {} from "x"` and `import type {} from "x"`: only the bare form
    // has nothing between `import` and the source string.
    if (
      statement.type === "ImportDeclaration" &&
      statement.specifiers.length === 0 &&
      statement.importKind !== "type" &&
      /^import\s*$/.test(parsed.source.slice(statement.start, statement.source.start)) &&
      !ALLOWED_BARE.test(statement.source.value)
    ) {
      found.push({ start: statement.start, what: `bare import "${statement.source.value}"` });
    }
  }
  walkModuleLoad(parsed.body, (node) => {
    if (node.type === "AwaitExpression" && node.argument?.type === "ImportExpression")
      found.push({ start: node.start, what: "top-level await import()" });
    else if (node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require")
      found.push({ start: node.start, what: "top-level require()" });
  });
  // An eager glob counts wherever it is written: the bundler rewrites it into static imports at the top of the module,
  // so a call inside a function (tools/cli/src/drop-ins.ts) still loads every match at import time.
  for (const statement of parsed.body) {
    walk(statement, (node) => {
      if (node.type === "CallExpression" && isEagerGlob(node))
        found.push({ start: node.start, what: "eager import.meta.glob" });
    });
  }
  return { effects: found };
}

export default function sideEffectImports(ctx) {
  return astRatchet(ctx, {
    rule: "side-effect-imports",
    metrics: { effects: { noun: "module-load side effect", advice: ADVICE } },
    measure
  });
}
