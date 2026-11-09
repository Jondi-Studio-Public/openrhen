import assert from "node:assert/strict";
import { test } from "node:test";
import { lineOf, parse, walk } from "../repository/rules/ast.mjs";

const TS = `import type { A } from "./a";
import { b } from "./b";
export const c = { n: 1 } satisfies Record<string, number>;
export function d<T>(x: T): T { return x; }
`;
const TSX = `${TS}export const e = <div>{c.n}</div>;\n`;
const MJS = `import { b } from "./b";
export const c = { n: 1 };
export function d(x) { return x; }
`;
const kinds = (file, source) => parse(file, source).body.map((s) => s.type);

test("parses .ts, .tsx and .mjs with type-only imports and satisfies", () => {
  const ts = kinds("x.ts", TS);
  assert.deepEqual(ts, ["ImportDeclaration", "ImportDeclaration", "ExportNamedDeclaration", "ExportNamedDeclaration"]);
  assert.deepEqual(kinds("x.tsx", TSX), [...ts, "ExportNamedDeclaration"]);
  assert.deepEqual(kinds("x.mjs", MJS), ["ImportDeclaration", "ExportNamedDeclaration", "ExportNamedDeclaration"]);
});

test("parses a top-level await import() and an ASI-less side-effect import", () => {
  const body = parse("x.ts", `import "./private/index"\nawait import("./x");\n`).body;
  assert.deepEqual(
    body.map((s) => s.type),
    ["ImportDeclaration", "ExpressionStatement"]
  );
  assert.equal(body[0].specifiers.length, 0);
});

test("a syntax error throws with the file name", () => {
  assert.throws(() => parse("bad.ts", "const = ;"), /could not parse bad\.ts/);
});

test("an unknown extension throws", () => {
  assert.throws(() => parse("x.css", ""), /cannot parse x\.css/);
});

test("walk visits nested nodes and lineOf reports 1-based lines", () => {
  const { body, source } = parse("x.ts", "const a = 1;\nconst b = process.env.X;\n");
  const found = [];
  walk(body[1], (n) => {
    if (n.type === "MemberExpression") found.push(lineOf(source, n));
  });
  assert.ok(found.length > 0 && found.every((l) => l === 2));
});
