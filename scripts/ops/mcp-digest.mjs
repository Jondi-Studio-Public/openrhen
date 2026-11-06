/**
 * Summarises the portal's per-request log lines for `POST /mcp` tool calls.
 *
 * Pure: it takes lines of text (JSON log lines, optionally behind a `docker compose logs` prefix such as
 * `portal-1  | `) and groups strings and numbers. It imports nothing from the portal, so it cannot widen what a log
 * line may carry. It keys on `mcpOutcome`, never the HTTP status: a failed tool call answers 200, a scope refusal 403.
 * `idTag` repeats are retries of one caller-given command id; the tag is salted per portal process, so a restart
 * starts counting again.
 */

const ROUTE = "/mcp";
const TOP_PAIRS = 10;

/** The JSON object on a log line, or undefined for anything else (a banner, a truncated line, an array). */
export function parseLine(text) {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  try {
    const value = JSON.parse(text.slice(start));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Nearest-rank percentile of numbers; 0 for none. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** @param {Iterable<string>} lines */
export function digest(lines) {
  const byTool = new Map();
  const pairs = new Map();
  let totalCalls = 0;
  let skipped = 0;
  for (const text of lines) {
    if (text.trim() === "") continue;
    const entry = parseLine(text);
    if (!entry) {
      skipped += 1;
      continue;
    }
    if (entry.route !== ROUTE || typeof entry.mcpTool !== "string") continue;
    totalCalls += 1;
    let tool = byTool.get(entry.mcpTool);
    if (!tool) {
      tool = { durations: [], sizes: [], errors: 0, byErrorCode: {}, tags: new Map(), retryable: 0, calls: 0 };
      byTool.set(entry.mcpTool, tool);
    }
    tool.calls += 1;
    tool.durations.push(number(entry.durationMs));
    tool.sizes.push(number(entry.resultBytes));
    if (entry.mcpRetryable === true) tool.retryable += 1;
    if (typeof entry.idTag === "string") tool.tags.set(entry.idTag, (tool.tags.get(entry.idTag) ?? 0) + 1);
    if (entry.mcpOutcome === "tool_error" || entry.mcpOutcome === "protocol_error") {
      tool.errors += 1;
      const code = String(entry.toolErrorCode ?? "other");
      tool.byErrorCode[code] = (tool.byErrorCode[code] ?? 0) + 1;
      const key = JSON.stringify([entry.mcpTool, code]);
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const tools = [...byTool.entries()]
    .map(([name, tool]) => ({
      tool: name,
      calls: tool.calls,
      errors: tool.errors,
      errorRate: tool.errors / tool.calls,
      byErrorCode: tool.byErrorCode,
      durationMs: {
        p50: percentile(tool.durations, 50),
        p95: percentile(tool.durations, 95),
        max: Math.max(...tool.durations)
      },
      resultBytes: { p50: percentile(tool.sizes, 50), max: Math.max(...tool.sizes) },
      retriedCalls: [...tool.tags.values()].reduce((sum, count) => sum + (count - 1), 0),
      retryable: tool.retryable
    }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
  const topErrors = [...pairs.entries()]
    .map(([key, count]) => {
      const [tool, errorCode] = JSON.parse(key);
      return { tool, errorCode, count };
    })
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool) || a.errorCode.localeCompare(b.errorCode))
    .slice(0, TOP_PAIRS);
  return { totalCalls, skipped, tools, topErrors };
}

const pad = (value, width) => String(value).padEnd(width);
const padLeft = (value, width) => String(value).padStart(width);

/** The digest as a plain-text report. */
export function formatDigest(result) {
  if (result.totalCalls === 0) return "No /mcp tool calls found in the input.\n";
  const width = Math.max(4, ...result.tools.map((tool) => tool.tool.length));
  const out = [
    `${result.totalCalls} tool calls (${result.skipped} unreadable lines skipped)`,
    "",
    [
      pad("tool", width),
      padLeft("calls", 6),
      padLeft("err%", 6),
      padLeft("p50ms", 7),
      padLeft("p95ms", 7),
      padLeft("maxms", 7),
      padLeft("p50B", 8),
      padLeft("maxB", 8),
      padLeft("retries", 8),
      "  error codes"
    ].join(" ")
  ];
  for (const tool of result.tools) {
    const codes = Object.entries(tool.byErrorCode)
      .map(([code, count]) => `${code}=${count}`)
      .join(" ");
    out.push(
      [
        pad(tool.tool, width),
        padLeft(tool.calls, 6),
        padLeft(`${Math.round(tool.errorRate * 100)}%`, 6),
        padLeft(tool.durationMs.p50, 7),
        padLeft(tool.durationMs.p95, 7),
        padLeft(tool.durationMs.max, 7),
        padLeft(tool.resultBytes.p50, 8),
        padLeft(tool.resultBytes.max, 8),
        padLeft(tool.retriedCalls, 8),
        `  ${codes}`
      ]
        .join(" ")
        .trimEnd()
    );
  }
  if (result.topErrors.length > 0) {
    out.push("", "Top errors", `${pad("tool", width)} ${pad("code", 18)} count`);
    for (const pair of result.topErrors) out.push(`${pad(pair.tool, width)} ${pad(pair.errorCode, 18)} ${pair.count}`);
  }
  return `${out.join("\n")}\n`;
}
