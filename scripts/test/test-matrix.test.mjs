import assert from "node:assert/strict";
import test from "node:test";
import { buildMatrix, SHARDS } from "../ci/test-matrix.mjs";

const pkg = (dir, scripts) => ({ dir, name: dir, scripts, deps: [] });
const packages = [
  pkg("portal", { test: "x", "test:integration": "x" }),
  pkg("platform/database", { test: "x", "test:integration": "x" }),
  pkg("engine/core", { test: "x" })
];

test("a full run shards the portal and the database and keeps every other package in one leg", () => {
  const m = buildMatrix({ packages });
  assert.equal(m.integration.length, SHARDS.integration.portal + SHARDS.integration["platform/database"]);
  assert.equal(m.unit.length, SHARDS.unit.portal + 1);
  assert.deepEqual(m.unit.at(-1), { name: "other packages", dir: "", shard: "" });
  assert.deepEqual(new Set(m.integration.map((leg) => leg.shard)).size > 1, true);
});

test("only the selected packages get legs", () => {
  const m = buildMatrix({
    packages,
    unitFilter: "--filter=./engine/core",
    integrationFilter: "--filter=./platform/database"
  });
  assert.deepEqual(
    m.unit.map((leg) => leg.name),
    ["other packages"]
  );
  assert.ok(m.integration.every((leg) => leg.dir === "platform/database"));
});

test("a suite that affected.mjs skipped has no legs", () => {
  const m = buildMatrix({ packages, unit: false, integration: false });
  assert.deepEqual([m.unit, m.integration], [[], []]);
});
