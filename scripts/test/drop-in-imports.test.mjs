import assert from "node:assert/strict";
import { test } from "node:test";
import { checkDropInImports, importSpecifiers } from "../repository/rules/drop-in-imports.mjs";

const SRC = "integrations/outbound-proxy/src";
const check = (path, source) => checkDropInImports(`${SRC}/${path}`, source);

test("a drop-in may import its own folder and the host's public modules", () => {
  const source = [
    `import { a } from "./local.js";`,
    `import { b } from "./deeper/b.js";`,
    `import { registerProxyRoute } from "../../host/route-registry.js";`,
    `import { registerConnection } from "../../host/connection-registry.js";`,
    `import type { BoundConnection } from "../../host/connection-api.js";`,
    `import { json } from "../../host/http.js";`,
    `import { c } from "@openrhen/contracts";`,
    `export { d } from "./d.js";`
  ].join("\n");
  assert.deepEqual(check("drop-ins/one/register.ts", source), []);
});

test("must fail: a drop-in reaching a core connection, another drop-in, or the server", () => {
  for (const specifier of [
    "../../connections/own/connection.js",
    "../two/register.js",
    "../../server.js",
    "../../host/rate.js"
  ]) {
    const errors = check("drop-ins/one/register.ts", `import { x } from "${specifier}";\n`);
    assert.equal(errors.length, 1, specifier);
    assert.match(errors[0], new RegExp(`drop-ins/one/register\\.ts:1 imports ${specifier.replaceAll(".", "\\.")}`));
  }
});

test("must fail: a re-export, a dynamic import and a require leave the folder too", () => {
  const source = `export * from "../../server.js";\nconst m = await import("../../connections/own/connection.js");\nconst r = require("../two/x");\n`;
  const errors = check("drop-ins/one/register.ts", source);
  assert.deepEqual(
    errors.map((e) => e.match(/:(\d+) /)[1]),
    ["1", "2", "3"]
  );
});

test("a drop-in test may also reach the server and its test support, but its code may not", () => {
  const source = `import { handleRequest } from "../../server.js";\nimport { start } from "../../server-test-support.js";\n`;
  assert.deepEqual(check("drop-ins/one/routes.test.ts", source), []);
  assert.equal(check("drop-ins/one/routes.ts", source).length, 2);
});

test("must fail: shared proxy code importing a drop-in by path", () => {
  const errors = check("server.ts", `import "./drop-ins/one/register.js";\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /imports \.\/drop-ins\/one\/register\.js, a drop-in/);
  assert.equal(check("host/http.ts", `import { x } from "../drop-ins/one/x.js";\n`).length, 1);
});

test("shared code may import the loader file, which is the registry's entry", () => {
  assert.deepEqual(check("server.ts", `import "./drop-ins.js";\n`), []);
  assert.deepEqual(check("host/bundled-connections.ts", `import "../drop-ins.js";\n`), []);
});

test("the loader, other packages and package imports are not checked", () => {
  assert.deepEqual(check("drop-ins.ts", `await import("./drop-ins/one/register.js");\n`), []);
  assert.deepEqual(
    check("server.ts", `import { x } from "./host/http.js";\nimport "@openrhen/outbound-proxy/sdk";\n`),
    []
  );
  assert.deepEqual(
    checkDropInImports(
      "portal/server/x.ts",
      `import { x } from "../../integrations/outbound-proxy/src/drop-ins/a/b";\n`
    ),
    []
  );
});

test("a string that only looks like an import is not one", () => {
  const source = `// import x from "../../server.js"\nconst s = 'import y from "../../server.js"';\n`;
  assert.deepEqual(importSpecifiers("a.ts", source), []);
  assert.deepEqual(check("drop-ins/one/register.ts", source), []);
});
