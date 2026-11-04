import assert from "node:assert/strict";
import { test } from "node:test";
import { extensionWriters, registerWriters } from "../repository/write-path-extensions.mjs";

// This file never loads private/index.mjs, so it sees the registry as the OpenRhen export does.
test("a build with no extension adds no write path", () => {
  assert.deepEqual(extensionWriters(), {});
});

test("registered write paths are merged", () => {
  registerWriters({ "a.ts": ["x"] });
  registerWriters({ "b.ts": ["y"] });
  assert.deepEqual(Object.keys(extensionWriters()), ["a.ts", "b.ts"]);
});
