import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_SECRET_READERS,
  findSecretReaderViolations,
  findStaleSecretReaderAllowances
} from "../repository/secret-reader-rule.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const reads = (source, text) => findSecretReaderViolations([{ source, text }]);

test("a route that imports the secret reader is a violation (the fixture the rule exists for)", () => {
  const violating = readFileSync(join(root, "scripts/test/fixtures/secret-reader-violation/route.ts.txt"), "utf8");
  const errors = reads("portal/app/api/leaky/route.ts", violating);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /portal\/app\/api\/leaky\/route\.ts imports the secret reader/);
  assert.match(errors[0], /youtube-proxy-client\.ts/);
});

test("the proxy-call helper may import it", () => {
  const text = `import { readSecret } from "@/server/secrets/read-secret";`;
  assert.deepEqual(reads(ALLOWED_SECRET_READERS[0], text), []);
});

test("every way of naming the module is caught", () => {
  for (const text of [
    `import { readSecret } from "@/server/secrets/read-secret";`,
    `import { readSecret } from '@/server/secrets/read-secret.ts';`,
    `import("@/server/secrets/read-secret")`,
    `const m = await import('@/server/secrets/read-secret.js');`,
    `export { readSecret } from "@/server/secrets/read-secret";`,
    `import "@/server/secrets/read-secret";`,
    `const m = require("@/server/secrets/read-secret");`
  ])
    assert.equal(reads("portal/server/some-feature.ts", text).length, 1, text);
  // A relative path from a sibling file, and from another folder, resolve to the same module.
  assert.equal(reads("portal/server/secrets/other.ts", `import { readSecret } from "./read-secret";`).length, 1);
  assert.equal(
    reads("portal/server/watch-history/x.ts", `import { readSecret } from "../secrets/read-secret.js";`).length,
    1
  );
});

test("other modules with a similar name, tests, and the module itself are not violations", () => {
  assert.deepEqual(reads("portal/server/x.ts", `import { a } from "@/server/other/read-secret";`), []);
  assert.deepEqual(reads("portal/server/x.ts", `import { a } from "@/server/secrets/read-secrets";`), []);
  assert.deepEqual(reads("portal/server/x.ts", `import { a } from "./read-secret";`), []);
  assert.deepEqual(reads("portal/server/x.test.ts", `import { readSecret } from "@/server/secrets/read-secret";`), []);
  assert.deepEqual(reads("portal/server/secrets/read-secret.ts", `import { a } from "./secrets-crypto";`), []);
});

test("the real tree has no other reader, and the allowed helper still imports the module", () => {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", ".next", ".vinext"].includes(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|mjs)$/.test(entry.name))
        files.push({ source: relative(root, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
    }
  };
  for (const dir of ["portal", "platform", "engine", "integrations", "tools", "scripts"]) walk(join(root, dir));
  assert.deepEqual(findSecretReaderViolations(files), []);
  assert.deepEqual(findStaleSecretReaderAllowances(files), []);
});

const crypto = "portal/server/secrets/secrets-crypto";

test("a backtick specifier is caught", () => {
  assert.equal(reads("portal/server/x.ts", "const m = await import(`@/server/secrets/read-secret`);").length, 1);
});

test("a path that climbs with .. and comes back is normalised before it is compared", () => {
  assert.equal(
    reads("portal/server/x.ts", `import { a } from "@/server/watch-history/../secrets/read-secret";`).length,
    1
  );
  assert.equal(
    reads("portal/server/x.ts", `import { a } from "@/server/./secrets/../secrets/read-secret.js";`).length,
    1
  );
  assert.equal(
    reads("portal/server/watch-history/x.ts", `import { a } from "../../../portal/server/secrets/read-secret";`).length,
    1
  );
});

test("a comment that mentions the module is not an import", () => {
  assert.deepEqual(
    reads("portal/server/x.ts", `// from "@/server/secrets/read-secret"\n/* import("@/server/secrets/read-secret") */`),
    []
  );
});

test("a dynamic import or require on a computed name is refused in portal source, and a literal one is not", () => {
  for (const text of [
    "const m = await import(name);",
    'const m = await import("@/server/" + "secrets/read-secret");',
    "const m = await import(`@/server/secrets/${which}`);",
    "const m = require(path);",
    "const m = await import(\n  base + file\n);"
  ])
    assert.equal(reads("portal/server/x.ts", text).length, 1, text);
  for (const text of [
    'const m = await import("./other");',
    "const m = await import(`./other`);",
    'const m = require("node:fs");',
    "// import(name) in a comment",
    "typeof import('x')"
  ])
    assert.deepEqual(reads("portal/server/x.ts", text), [], text);
  // Outside portal source, and in portal build tooling, the rule does not apply.
  assert.deepEqual(reads("scripts/x.mjs", "await import(name);"), []);
  assert.deepEqual(reads("portal/scripts/x.mjs", "await import(name);"), []);
});

test("the barrel, the folder and its index are refused", () => {
  for (const specifier of ["@/server/secrets", "@/server/secrets/index", "./secrets", "./secrets/index.js"])
    assert.equal(reads("portal/server/x.ts", `import * as s from "${specifier}";`).length, 1, specifier);
  assert.equal(reads("portal/server/watch-history/x.ts", `export * from "../secrets";`).length, 1);
});

test("the crypto module is for the store, the reader and the policy only", () => {
  const text = `import { loadMasterKey } from "@/server/secrets/secrets-crypto";`;
  assert.equal(reads("portal/server/persistence/postgres/watch-history-store.ts", text).length, 1);
  assert.equal(
    reads("portal/app/api/leaky/route.ts", `import { decryptSecret } from "${"@/server/secrets/secrets-crypto"}";`)
      .length,
    1
  );
  assert.equal(reads("portal/server/x.ts", `import("@/server/watch-history/../secrets/secrets-crypto")`).length, 1);
  for (const allowed of [
    "portal/server/persistence/postgres/app-secrets-store.ts",
    "portal/server/secrets/read-secret.ts",
    "portal/server/secrets/secrets-policy.ts"
  ])
    assert.deepEqual(reads(allowed, text), [], allowed);
  assert.deepEqual(reads("portal/server/x.test.ts", text), []);
  assert.ok(crypto.endsWith("secrets-crypto"));
});

test("a stale allowance is reported", () => {
  assert.equal(findStaleSecretReaderAllowances([], ["portal/x.ts"], []).length, 1);
  assert.equal(
    findStaleSecretReaderAllowances([{ source: "portal/x.ts", text: "export {}" }], ["portal/x.ts"], []).length,
    1
  );
  assert.equal(findStaleSecretReaderAllowances([], [], ["portal/y.ts"]).length, 1);
});
