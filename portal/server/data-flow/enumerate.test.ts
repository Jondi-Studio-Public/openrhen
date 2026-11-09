import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  exportedMethods,
  loopStartFiles,
  parseImports,
  resolveClosure,
  serviceLoopNames,
  tablesWrittenIn,
  workerLoopNames
} from "./enumerate";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "data-flow-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("parseImports", () => {
  it("reads named, default, namespace, side-effect, re-export and dynamic imports, and skips type imports", () => {
    const edges = parseImports(`
      // import { fromComment } from "./comment";
      import type { OnlyType } from "./types";
      import Def, { a, b as c, type d } from "./mod";
      import * as ns from "@/server/ns";
      import "./side";
      export * from "./all";
      export { x as y } from "./re";
      export type { T } from "./type-re";
      const lazy = () => import("@/app/api/x/route");
    `);
    expect(edges).toEqual([
      { specifier: "./mod", names: ["default", "a", "b"] },
      { specifier: "@/server/ns", names: "all" },
      { specifier: "./side", names: "all" },
      { specifier: "./all", names: "all" },
      { specifier: "./re", names: ["x"] },
      { specifier: "@/app/api/x/route", names: "all" }
    ]);
  });
});

describe("tablesWrittenIn", () => {
  const known = new Set(["offer_log", "notes", "actions"]);
  const drizzle = new Map([["notesTable", "notes"]]);
  it("finds SQL writes and drizzle writes of known tables only, and ignores comments", () => {
    const text = `
      // INSERT INTO actions is only mentioned here
      await tx\`INSERT INTO offer_log (a) VALUES (1)\`;
      sql\`UPDATE notes SET x = 1\`;
      sql\`DELETE FROM unknown_table\`;
      await db.insert(notesTable).values({});
      /* UPDATE actions */
      const update = "update of nothing";
    `;
    expect([...tablesWrittenIn(text, known, drizzle)].sort()).toEqual(["notes", "offer_log"]);
  });
});

describe("exportedMethods", () => {
  it("reads const, function and list exports", () => {
    expect(exportedMethods(`export const GET = withRoute("/x", h); export async function POST() {}`)).toEqual([
      "GET",
      "POST"
    ]);
    expect(exportedMethods(`const a = 1; export { a as PATCH, DELETE };`)).toEqual(["PATCH", "DELETE"]);
    expect(exportedMethods(`export const getThing = 1;`)).toEqual([]);
  });
});

describe("resolveClosure", () => {
  const files = {
    "portal/package.json": JSON.stringify({ name: "@openrhen/portal" }),
    "platform/db/package.json": JSON.stringify({
      name: "@openrhen/db",
      exports: { ".": "./src/index.ts", "./schema": "./src/schema.ts" }
    }),
    "platform/db/src/index.ts": `export * from "./offer.js";\nexport { other } from "./other.js";\nexport * from "./big.js";\n`,
    "platform/db/src/offer.ts": `import { helper } from "./helper.js";\nexport async function recordShown() { await sql\`INSERT INTO offer_log\`; helper(); }\n`,
    "platform/db/src/helper.ts": `export const helper = () => 1;\n`,
    "platform/db/src/other.ts": `export const other = () => sql\`INSERT INTO notes\`;\n`,
    "platform/db/src/big.ts": `export const big = () => sql\`INSERT INTO big_table\`;\n`,
    "platform/db/src/schema.ts": `export const schemaOnly = 1;\n`,
    "portal/server/writer.ts": `import { recordShown } from "@openrhen/db";\nimport { pool } from "@/server/pool";\nimport type { Nope } from "@/server/never";\nexport const w = () => recordShown();\n`,
    "portal/server/pool.ts": `import { deep } from "./deep";\nexport const pool = 1;\n`,
    "portal/server/deep.ts": `export const deep = () => sql\`INSERT INTO pool_table\`;\n`,
    "portal/server/never.ts": `export type Nope = 1;\n sql\`INSERT INTO never_table\`;\n`,
    "portal/app/api/x/route.ts": `import { w } from "@/server/writer";\nimport { overlay } from "@/server/overlay-file";\nimport "@/server/private/index";\nexport const GET = () => w();\n`,
    "portal/server/overlay-file.ts": `export const overlay = () => sql\`INSERT INTO overlay_table\`;\n`,
    "portal/server/private/index.ts": `export {};\n`
  };

  it("resolves a named import through barrels to the defining module, not the barrel's other modules", () => {
    const root = tree(files);
    const closure = resolveClosure(["portal/app/api/x/route.ts"], {
      root,
      stops: new Map([["portal/server/pool.ts", "infra"]])
    });
    expect(closure.files).toEqual([
      "platform/db/src/helper.ts",
      "platform/db/src/offer.ts",
      "portal/app/api/x/route.ts",
      "portal/server/overlay-file.ts",
      "portal/server/writer.ts"
    ]);
    expect(closure.files).not.toContain("platform/db/src/big.ts");
    expect(closure.files).not.toContain("platform/db/src/index.ts");
  });

  it("stops at pipe, infra, overlay and seam modules without scanning them", () => {
    const root = tree(files);
    const closure = resolveClosure(["portal/app/api/x/route.ts"], {
      root,
      stops: new Map([
        ["portal/server/pool.ts", "infra"],
        ["portal/server/overlay-file.ts", "overlay"]
      ])
    });
    expect(closure.files).not.toContain("portal/server/pool.ts");
    expect(closure.files).not.toContain("portal/server/deep.ts");
    expect(closure.files).not.toContain("portal/server/overlay-file.ts");
    expect(closure.stopped).toEqual([
      { path: "portal/server/overlay-file.ts", reason: "overlay" },
      { path: "portal/server/pool.ts", reason: "infra" },
      { path: "portal/server/private/index.ts", reason: "seam" }
    ]);
  });

  it("caps depth", () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1)
      chain[`portal/server/c${i}.ts`] = `import { n${i + 1} } from "./c${i + 1}";\nexport const n${i} = 1;\n`;
    const root = tree(chain);
    const closure = resolveClosure(["portal/server/c0.ts"], { root, maxDepth: 3 });
    expect(closure.files).toEqual([
      "portal/server/c0.ts",
      "portal/server/c1.ts",
      "portal/server/c2.ts",
      "portal/server/c3.ts"
    ]);
    expect(closure.truncated).toEqual(["portal/server/c3.ts"]);
  });

  it("expands a directory start into its files", () => {
    const root = tree({ "integrations/x/src/sub/a.ts": "export {};", "integrations/x/src/sub/b.ts": "export {};" });
    expect(resolveClosure(["integrations/x/src/sub/"], { root }).files).toEqual([
      "integrations/x/src/sub/a.ts",
      "integrations/x/src/sub/b.ts"
    ]);
  });
});

describe("GET route that writes (device/now)", () => {
  it("reaches the offer log table through the barrel and stops at infrastructure", () => {
    const root = tree({
      "platform/db/package.json": JSON.stringify({ name: "@openrhen/database", exports: { ".": "./src/index.ts" } }),
      "platform/db/src/index.ts": `export * from "./offer-log/offer-log.js";\nexport * from "./push/push.js";\n`,
      "platform/db/src/offer-log/offer-log.ts": `export async function recordShown() { return sql\`INSERT INTO offer_log (a) VALUES (1)\`; }\n`,
      "platform/db/src/push/push.ts": `export const sendPush = () => sql\`INSERT INTO push_log\`;\n`,
      "portal/package.json": JSON.stringify({ name: "@openrhen/portal" }),
      "portal/app/api/device/now/route.ts": `import { logDeviceShown } from "@/server/device/device-shown";\nexport const GET = async () => logDeviceShown();\n`,
      "portal/server/device/device-shown.ts": `import { logOfferShown } from "@/server/persistence/offer-log-writer";\nimport { sqlPool } from "@/server/persistence/sql-pool";\nexport const logDeviceShown = () => logOfferShown(sqlPool);\n`,
      "portal/server/persistence/offer-log-writer.ts": `import { recordShown } from "@openrhen/database";\nexport const logOfferShown = (sql) => sql.begin((tx) => recordShown(tx));\n`,
      "portal/server/persistence/sql-pool.ts": `export const sqlPool = () => sql\`INSERT INTO pool_table\`;\n`
    });
    const closure = resolveClosure(["portal/app/api/device/now/route.ts"], {
      root,
      stops: new Map([["portal/server/persistence/sql-pool.ts", "infra"]])
    });
    const known = new Set(["offer_log", "push_log", "pool_table"]);
    const written = new Set(
      closure.files.flatMap((file) => [...tablesWrittenIn(readFile(root, file), known, new Map())])
    );
    expect([...written]).toEqual(["offer_log"]);
  });
});

import { readFileSync } from "node:fs";
function readFile(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

describe("loop enumerators", () => {
  const main = `
    import { tickOne } from "./ticks/one";
    import { tickTwo, other } from "./two";
    await runIndependentLoops(
      [
        { name: "one", run: afterPortalReady(tickOne) },
        { name: "two", run: () => tickTwo(sql, other) },
        ...extraLoopSteps({}).map((step) => ({ name: step.name, run: step.run })),
        { name: "three", run: tickThree }
      ],
      {}
    );
    registerExtraLoop({ name: "ignored-here", create: () => null });
  `;
  it("L1 reads the literal names in the loops list and the extra-loop registrations, skipping the spread", () => {
    expect(workerLoopNames(main, [`registerExtraLoop({\n  name: "extra-a",\n  create() {} });`])).toEqual([
      "one",
      "two",
      "three",
      "extra-a"
    ]);
  });
  it("L2 reads namedLoop calls", () => {
    expect(serviceLoopNames([`namedLoop("sync", async () => {}); namedLoop( "tick" , run);`, "none here"])).toEqual([
      "sync",
      "tick"
    ]);
  });
  it("finds the modules a loop's run expression names", () => {
    const root = tree({
      "engine/worker/src/main.ts": main,
      "engine/worker/src/ticks/one.ts": "export const tickOne = 1;",
      "engine/worker/src/two.ts": "export const tickTwo = 1; export const other = 2;"
    });
    expect(loopStartFiles("engine/worker/src/main.ts", "one", { root })).toEqual(["engine/worker/src/ticks/one.ts"]);
    expect(loopStartFiles("engine/worker/src/main.ts", "two", { root })).toEqual(["engine/worker/src/two.ts"]);
  });
});
