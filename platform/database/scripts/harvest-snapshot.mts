// One-off utility to (re)build the drizzle-kit v7 snapshot for the CURRENT
// schema.ts without going through the interactive `drizzle-kit generate`
// diff/prompt flow. Uses drizzle-kit's public `generateDrizzleJson` API,
// which just serializes the schema module into a snapshot — it does not
// diff against the previous snapshot, so it can never trigger the
// column/table-rename prompts.
//
// Usage: tsx scripts/harvest-snapshot.mts <prevSnapshotFile> <outSnapshotFile>
import { readFileSync, writeFileSync } from "node:fs";
import { generateDrizzleJson } from "drizzle-kit/api";
import * as schema from "../src/schema.ts";

const [, , prevSnapshotPath, outPath] = process.argv;
if (!prevSnapshotPath || !outPath) {
  console.error("usage: tsx harvest-snapshot.mts <prevSnapshotFile> <outSnapshotFile>");
  process.exit(1);
}

const prevSnapshot = JSON.parse(readFileSync(prevSnapshotPath, "utf8"));
const json = generateDrizzleJson(schema, prevSnapshot.id);

writeFileSync(outPath, JSON.stringify(json, null, 2) + "\n");
console.log(`Wrote ${outPath} (id=${json.id}, prevId=${json.prevId})`);
