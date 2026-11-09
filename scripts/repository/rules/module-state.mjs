// Module-state ratchet (modularity plan A2, metrics S5 and S5b). Two sections of one shard:
//   state      S5: a module-level `let` or `var` (one hit per declarator, `export let` included) in a server-side
//              maintained source file. Boot modules are not exempt: boot returns a frozen context and keeps no top-level
//              `let`, so a `let` behind an exported getter in boot.ts counts like any other.
//   snapshots  S5b: a module-level `const` (or an immediately invoked function) whose value comes from a registry read, or
//              from `Object.keys/values/entries` of an object a registry extends. It is taken once at import, so it
//              misses everything registered afterwards. Checked in every maintained source file, client files included.
// A registry read is a call to one of REGISTRY_READERS; an extended object is one of EXTENDED_OBJECTS. A read inside a
// function body that is not invoked at load is lazy and is not a snapshot.
// Tests and test support are not read. Hits are held to per-lane pending shards
// (scripts/repository/pending/module-state/<lane>.json) that only shrink. See shared-state-ratchet.mjs.
import { EXTENDED_OBJECTS, REGISTRY_READERS, astRatchet, walkModuleLoad } from "../shared-state-ratchet.mjs";

const STATE_ADVICE =
  "Keep no mutable state at module level. Create it inside boot() (or the factory your module exports) and return it in the frozen context, or pass it as a parameter; boot.ts is not exempt. A const Map or Set that only this module writes is a memo cache and is not counted.";
const SNAPSHOT_ADVICE =
  "Do not take the value at import time. Make it a function that reads the registry when called, for example `export function ids() { return intervalCalendarSourceIds(); }`, so something registered after import is still seen.";

const readers = new Set(REGISTRY_READERS);
const extended = new Set(EXTENDED_OBJECTS);

function snapshotOf(initializer) {
  let what = null;
  walkModuleLoad([initializer], (node) => {
    if (what) return false;
    if (node.type !== "CallExpression") return;
    const callee = node.callee;
    if (callee?.type === "Identifier" && readers.has(callee.name)) what = `${callee.name}()`;
    else if (
      callee?.type === "MemberExpression" &&
      !callee.computed &&
      callee.object?.type === "Identifier" &&
      callee.object.name === "Object" &&
      ["keys", "values", "entries"].includes(callee.property.name) &&
      node.arguments[0]?.type === "Identifier" &&
      extended.has(node.arguments[0].name)
    )
      what = `Object.${callee.property.name}(${node.arguments[0].name})`;
  });
  return what;
}

function measure({ parsed, server }) {
  const state = [];
  const snapshots = [];
  for (const raw of parsed.body) {
    const statement = raw.type === "ExportNamedDeclaration" && raw.declaration ? raw.declaration : raw;
    if (statement.type !== "VariableDeclaration" || statement.declare) continue;
    for (const declarator of statement.declarations) {
      if (server && (statement.kind === "let" || statement.kind === "var")) {
        const names = declarator.id.type === "Identifier" ? declarator.id.name : "a destructured binding";
        state.push({ start: declarator.start, what: `${statement.kind} ${names}` });
      }
      if (statement.kind === "const" && declarator.init) {
        const what = snapshotOf(declarator.init);
        if (what) {
          const names = declarator.id.type === "Identifier" ? declarator.id.name : "a destructured binding";
          snapshots.push({ start: declarator.start, what: `${names} = ${what}` });
        }
      }
    }
  }
  return { state, snapshots };
}

export default function moduleState(ctx) {
  return astRatchet(ctx, {
    rule: "module-state",
    metrics: {
      state: { noun: "module-level let/var declaration", advice: STATE_ADVICE },
      snapshots: { noun: "module-level registry snapshot", advice: SNAPSHOT_ADVICE }
    },
    measure
  });
}
