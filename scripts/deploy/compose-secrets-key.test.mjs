import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// OPENRHEN_SECRETS_KEY seals the passwords and keys typed into the app. Only the portal reads it: the proxy, the
// worker, the engine, the migrate step and the backup service must not carry the master key.
const SOURCE = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");

/** The text of each service block, by name. */
function serviceBlocks() {
  const blocks = {};
  let service = null;
  let inServices = false;
  for (const line of SOURCE.split("\n")) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith("#")) inServices = false;
    if (!inServices) continue;
    const top = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (top) {
      service = top[1];
      blocks[service] = [];
    } else if (service) blocks[service].push(line);
  }
  return blocks;
}

test("wires OPENRHEN_SECRETS_KEY to the portal service only", () => {
  const blocks = serviceBlocks();
  const carrying = Object.entries(blocks)
    .filter(([, lines]) => lines.some((line) => /^\s+OPENRHEN_SECRETS_KEY:/.test(line)))
    .map(([name]) => name);
  assert.deepEqual(carrying, ["portal"]);
});

test("the portal gets it from .env with no default, so an unset key stays unset", () => {
  assert.match(SOURCE, /^\s+OPENRHEN_SECRETS_KEY: \$\{OPENRHEN_SECRETS_KEY:-\}\s*$/m);
});

test("the proxy comment no longer claims the portal holds no credential at all", () => {
  assert.doesNotMatch(SOURCE, /portal holds only OUTBOUND_PROXY_URL and a bearer token/);
  assert.match(SOURCE, /keys the person types into the app/i);
});
