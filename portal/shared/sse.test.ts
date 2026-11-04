import { describe, expect, it } from "vitest";
import { createSseParser, sseCommentFrame, sseEventFrame, sseFrame, sseRetryFrame } from "./sse";

describe("SSE parsing", () => {
  it("emits one payload per event however the chunks are split", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse('data: {"a"');
    parse(':1}\n\ndata: {"b":2}\n');
    parse("\n");
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("joins multi-line data, tolerates CRLF, and swallows [DONE]", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse("event: message\r\ndata: first\r\ndata: second\r\n\r\ndata: [DONE]\n\n");
    expect(seen).toEqual(["first\nsecond"]);
  });

  it("round-trips its own frames", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse(sseFrame({ kind: "delta", text: "hi" }) + sseFrame({ kind: "done" }));
    expect(seen.map((data) => JSON.parse(data))).toEqual([{ kind: "delta", text: "hi" }, { kind: "done" }]);
  });

  it("names an event frame and round-trips through the same parser", () => {
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse(sseEventFrame("changed", { kind: "planning", at: "2026-09-04T09:00:00.000Z" }));
    expect(seen.map((data) => JSON.parse(data))).toEqual([{ kind: "planning", at: "2026-09-04T09:00:00.000Z" }]);
  });

  it("formats a retry directive and a comment line, neither of which carries a data: payload", () => {
    expect(sseRetryFrame(3_000)).toBe("retry: 3000\n\n");
    expect(sseCommentFrame("ping")).toBe(": ping\n\n");
    const seen: string[] = [];
    const parse = createSseParser((data) => seen.push(data));
    parse(sseRetryFrame(3_000) + sseCommentFrame("ping") + sseFrame({ ok: true }));
    // Neither a `retry:` line nor a comment line is a `data:` payload, so only the real frame emits.
    expect(seen).toEqual(['{"ok":true}']);
  });
});
