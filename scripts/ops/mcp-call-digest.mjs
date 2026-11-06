#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { digest, formatDigest } from "./mcp-digest.mjs";

/**
 * `node scripts/ops/mcp-call-digest.mjs [log-file]`: reads portal log lines from the file, or stdin when none is
 * given, and prints per-tool call counts, error codes, timings, sizes and retries. `--json` prints the raw digest.
 * All the logic is in `mcp-digest.mjs`.
 */
const args = process.argv.slice(2);
const json = args.includes("--json");
const file = args.find((arg) => !arg.startsWith("--"));
const lines = [];
for await (const text of createInterface({ input: file ? createReadStream(file) : process.stdin })) lines.push(text);
const result = digest(lines);
process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : formatDigest(result));
