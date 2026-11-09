import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import dropInImports, { checkDropInImports, importSpecifiers } from "../repository/rules/drop-in-imports.mjs";

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

test("must fail: a no-substitution template dynamic import leaves the folder or names a drop-in", () => {
  const out = check("drop-ins/one/register.ts", "const m = await import(`../../server.js`);\n");
  assert.equal(out.length, 1);
  assert.match(out[0], /register\.ts:1 imports \.\.\/\.\.\/server\.js/);
  assert.equal(check("server.ts", "await import(`./drop-ins/one/register.js`);\n").length, 1);
});

test("must fail: a computed dynamic import that cannot be proven to stay inside", () => {
  // In a drop-in: no static prefix, or a prefix that leaves the folder.
  assert.equal(check("drop-ins/one/register.ts", "await import(name);\n").length, 1);
  assert.equal(check("drop-ins/one/register.ts", "await import(`./${name}.js`);\n").length, 0);
  assert.equal(
    check("drop-ins/one/register.ts", "await import(`../../connections/${name}/connection.js`);\n").length,
    1
  );
  assert.equal(check("drop-ins/one/register.ts", "await import('../' + name);\n").length, 1);
  // In shared code: a prefix that reaches the drop-in folder.
  assert.equal(check("server.ts", "await import(`./drop-ins/${name}/register.js`);\n").length, 1);
  assert.equal(check("host/x.ts", "await import('../drop-ins/' + name);\n").length, 1);
  // Shared code may compute an import that does not reach the folder, and the loader may compute its own.
  assert.deepEqual(
    check("server.ts", "await import(`./connections/${name}/connection.js`);\nawait import(name);\n"),
    []
  );
  assert.deepEqual(check("drop-ins.ts", "await import(`./drop-ins/${name}/register.js`);\n"), []);
});

test("must fail: vi.mock and its relatives name a module like an import does", () => {
  const source = [
    `vi.mock("../../connections/own/connection.js");`,
    `vi.doMock("../two/x.js", () => ({}));`,
    `await vi.importActual("../../server.js");`,
    `jest.mock("../../server.js");`,
    `vi.mock("../../host/http.js");`
  ].join("\n");
  const errors = check("drop-ins/one/register.ts", source);
  assert.deepEqual(
    errors.map((e) => e.match(/:(\d+) /)[1]),
    ["1", "2", "3", "4"]
  );
  assert.equal(check("server.test.ts", `vi.mock("./drop-ins/one/register.js");\n`).length, 1);
  assert.deepEqual(check("server.test.ts", `vi.mock("./host/http.js");\n`), []);
});

test("must fail: import.meta.glob that reaches a drop-in, or leaves one", () => {
  assert.equal(check("server.ts", `const m = import.meta.glob("./drop-ins/*/register.ts");\n`).length, 1);
  assert.equal(
    check("server.ts", `const m = import.meta.glob(["./connections/*.ts", "./drop-ins/**/*.ts"]);\n`).length,
    1
  );
  assert.equal(check("server.ts", `const m = import.meta.glob("./**/*.ts");\n`).length, 1);
  assert.equal(
    check("drop-ins/one/register.ts", `const m = import.meta.glob("../../connections/*/connection.ts");\n`).length,
    1
  );
  assert.deepEqual(check("drop-ins/one/register.ts", `const m = import.meta.glob("./routes/*.ts");\n`), []);
  assert.deepEqual(check("server.ts", `const m = import.meta.glob("./connections/*/connection.ts");\n`), []);
});

test("must fail: the folder's index file is a drop-in, though the loader file is not", () => {
  assert.equal(check("server.ts", `import "./drop-ins/index.js";\n`).length, 1);
  assert.equal(check("host/http.ts", `import { x } from "../drop-ins/index";\n`).length, 1);
  assert.equal(check("server.ts", `import "./drop-ins/one";\n`).length, 1);
  assert.deepEqual(check("server.ts", `import "./drop-ins.js";\nimport "./drop-ins";\n`), []);
});

test("must fail: a bare package specifier into the proxy's source is checked like a relative one", () => {
  const pkg = "@openrhen/outbound-proxy";
  const errors = check("drop-ins/one/register.ts", `import { x } from "${pkg}/src/connections/own/connection";\n`);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /imports @openrhen\/outbound-proxy\/src\/connections\/own\/connection/);
  assert.equal(check("server.ts", `import "${pkg}/src/drop-ins/one/register";\n`).length, 1);
  assert.equal(check("server.ts", `import "${pkg}/src/drop-ins/index.js";\n`).length, 1);
  assert.deepEqual(check("drop-ins/one/register.ts", `import { json } from "${pkg}/src/host/http.js";\n`), []);
  assert.deepEqual(check("drop-ins/one/register.ts", `import { x } from "${pkg}/src/drop-ins/one/x.js";\n`), []);
  assert.deepEqual(check("server.ts", `import "${pkg}/sdk";\nimport "${pkg}/src/drop-ins.js";\nimport "zod";\n`), []);
});

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });

test("the rule runs over a real git tree: tracked violations fail, untracked and clean files do not", () => {
  const dir = mkdtempSync(join(tmpdir(), "drop-in-imports-"));
  try {
    git(dir, "init", "-q");
    const files = {
      [`${SRC}/server.ts`]: `import "./drop-ins.js";\nimport "./drop-ins/one/register.js";\n`,
      [`${SRC}/host/http.ts`]: `export const json = 1;\n`,
      [`${SRC}/connections/own/connection.ts`]: `export const own = 1;\n`,
      [`${SRC}/drop-ins/one/register.ts`]: `import { json } from "../../host/http.js";\nawait import(\`../../connections/own/connection.js\`);\nimport { y } from "@openrhen/outbound-proxy/src/connections/own/connection";\nvi.mock("../../server.js");\n`,
      [`${SRC}/drop-ins/one/ok.ts`]: `import { json } from "../../host/http.js";\nimport("./register.js");\n`,
      [`${SRC}/drop-ins/index.ts`]: `export {};\n`,
      [`${SRC}/loader-user.ts`]: `import "./drop-ins/index.js";\n`,
      [`${SRC}/drop-ins/two/untracked.ts`]: `import "../../server.js";\n`,
      "portal/server/other.ts": `import "../../integrations/outbound-proxy/src/drop-ins/one/register.js";\n`
    };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    git(dir, "add", "-A");
    git(dir, "reset", "-q", "--", `${SRC}/drop-ins/two/untracked.ts`);
    const errors = dropInImports({ root: dir, args: [] });
    const at = (file, line) => errors.some((e) => e.startsWith(`${SRC}/${file}:${line} `));
    assert.ok(at("server.ts", 2), errors.join("\n"));
    assert.ok(at("drop-ins/one/register.ts", 2), errors.join("\n"));
    assert.ok(at("drop-ins/one/register.ts", 3), errors.join("\n"));
    assert.ok(at("drop-ins/one/register.ts", 4), errors.join("\n"));
    assert.ok(at("loader-user.ts", 1), errors.join("\n"));
    assert.equal(errors.length, 5, errors.join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
