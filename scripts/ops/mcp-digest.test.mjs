import assert from "node:assert/strict";
import { test } from "node:test";
import { digest, formatDigest, parseLine, percentile } from "./mcp-digest.mjs";

const line = (fields) =>
  JSON.stringify({ level: "info", message: "Portal request", route: "/mcp", method: "POST", status: 200, ...fields });

test("percentile is nearest-rank and empty-safe", () => {
  assert.equal(percentile([], 50), 0);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
});

test("parseLine tolerates a docker compose prefix and skips what is not a JSON object", () => {
  assert.deepEqual(parseLine('portal-1  | {"a":1}'), { a: 1 });
  assert.equal(parseLine("portal-1  | starting up"), undefined);
  assert.equal(parseLine('{"a":'), undefined);
  assert.equal(parseLine(""), undefined);
  assert.equal(parseLine("[1,2]"), undefined);
});

const FIXTURE = [
  line({
    mcpTool: "rhen_status",
    mcpMethod: "tools/call",
    mcpOutcome: "ok",
    durationMs: 10,
    resultBytes: 100,
    argBytes: 2
  }),
  line({
    mcpTool: "rhen_status",
    mcpMethod: "tools/call",
    mcpOutcome: "ok",
    durationMs: 20,
    resultBytes: 300,
    argBytes: 2
  }),
  line({
    mcpTool: "rhen_status",
    mcpMethod: "tools/call",
    mcpOutcome: "ok",
    durationMs: 30,
    resultBytes: 200,
    argBytes: 2
  }),
  line({
    mcpTool: "rhen_status",
    mcpMethod: "tools/call",
    mcpOutcome: "ok",
    durationMs: 400,
    resultBytes: 900,
    argBytes: 2
  }),
  `portal-1  | ${line({ mcpTool: "rhen_save", mcpMethod: "tools/call", mcpOutcome: "tool_error", toolErrorCode: "validation", durationMs: 5, resultBytes: 50, argBytes: 40, idTag: "aaaaaaaa" })}`,
  line({
    mcpTool: "rhen_save",
    mcpMethod: "tools/call",
    mcpOutcome: "tool_error",
    toolErrorCode: "unavailable",
    mcpRetryable: true,
    durationMs: 50,
    resultBytes: 60,
    argBytes: 40,
    idTag: "bbbbbbbb"
  }),
  line({
    mcpTool: "rhen_save",
    mcpMethod: "tools/call",
    mcpOutcome: "ok",
    durationMs: 15,
    resultBytes: 70,
    argBytes: 40,
    idTag: "bbbbbbbb"
  }),
  line({
    mcpTool: "rhen_save",
    mcpMethod: "tools/call",
    mcpOutcome: "tool_error",
    toolErrorCode: "validation",
    durationMs: 6,
    resultBytes: 50,
    argBytes: 40
  }),
  line({
    mcpTool: "unknown",
    mcpMethod: "tools/call",
    mcpOutcome: "protocol_error",
    toolErrorCode: -32602,
    durationMs: 1,
    resultBytes: 80,
    argBytes: 2
  }),
  // Not counted: another route, no tool, malformed, not JSON.
  line({ route: "/api/state", mcpTool: "rhen_status", durationMs: 1 }),
  line({ mcpMethod: "tools/list", durationMs: 3, resultBytes: 9000 }),
  '{"route":"/mcp","mcpTool":',
  "docker: noise",
  ""
];

test("digest groups by tool and outcome, not HTTP status", () => {
  const result = digest(FIXTURE);
  assert.deepEqual(
    result.tools.map((tool) => tool.tool),
    ["rhen_save", "rhen_status", "unknown"]
  );
  const status = result.tools.find((tool) => tool.tool === "rhen_status");
  assert.equal(status.calls, 4);
  assert.equal(status.errors, 0);
  assert.equal(status.errorRate, 0);
  assert.equal(status.durationMs.p50, 20);
  assert.equal(status.durationMs.p95, 400);
  assert.equal(status.durationMs.max, 400);
  assert.equal(status.resultBytes.p50, 200);
  assert.equal(status.resultBytes.max, 900);
  const save = result.tools.find((tool) => tool.tool === "rhen_save");
  assert.equal(save.calls, 4);
  assert.equal(save.errors, 3);
  assert.equal(save.errorRate, 0.75);
  assert.deepEqual(save.byErrorCode, { validation: 2, unavailable: 1 });
  assert.equal(save.retriedCalls, 1);
  assert.equal(save.retryable, 1);
  assert.equal(result.tools.find((tool) => tool.tool === "unknown").errors, 1);
  assert.equal(result.totalCalls, 9);
  assert.equal(result.skipped, 2);
});

test("digest ranks (tool, error code) pairs and keeps ten", () => {
  const result = digest(FIXTURE);
  assert.deepEqual(result.topErrors[0], { tool: "rhen_save", errorCode: "validation", count: 2 });
  assert.equal(result.topErrors.length, 3);
  const many = Array.from({ length: 15 }, (_, index) =>
    line({
      mcpTool: `tool_${index}`,
      mcpOutcome: "tool_error",
      toolErrorCode: "conflict",
      durationMs: 1,
      resultBytes: 1
    })
  );
  assert.equal(digest(many).topErrors.length, 10);
});

test("digest of nothing is empty, and the text says so", () => {
  const result = digest([]);
  assert.equal(result.totalCalls, 0);
  assert.match(formatDigest(result), /No \/mcp tool calls/);
});

test("formatDigest prints a row per tool and the top pairs", () => {
  const text = formatDigest(digest(FIXTURE));
  assert.match(text, /rhen_save\s+4\s+75%/);
  assert.match(text, /rhen_status\s+4\s+0%/);
  assert.match(text, /rhen_save\s+validation\s+2/);
});
