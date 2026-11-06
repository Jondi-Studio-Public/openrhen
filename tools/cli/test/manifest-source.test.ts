import { MCP_COMMON_PARAMS } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { COMMON_PARAMS } from "../src/remote-text.js";
import { manifestSource } from "../src/manifest-source.js";

describe("manifestSource", () => {
  it("refers to a shared write-parameter text by name and leaves any other text alone", () => {
    const { source, usesCommonParams } = manifestSource([
      {
        name: "rhen_example",
        properties: {
          basis: { type: "string", description: MCP_COMMON_PARAMS.basis },
          "command-id": { type: "string", description: MCP_COMMON_PARAMS["command-id"] },
          answer: { type: "string", description: `${MCP_COMMON_PARAMS.basis} (own wording)` }
        }
      }
    ]);
    expect(usesCommonParams).toBe(true);
    expect(source).toContain('"description": MCP_COMMON_PARAMS["basis"]');
    expect(source).toContain('"description": MCP_COMMON_PARAMS["command-id"]');
    expect(source).toContain(`"description": ${JSON.stringify(`${MCP_COMMON_PARAMS.basis} (own wording)`)}`);
    // The shared text itself is no longer copied into the generated source.
    expect(source).not.toContain(`: ${JSON.stringify(MCP_COMMON_PARAMS.basis)}`);
  });

  it("is stable: the same tree gives the same source, and text with quotes or newlines survives", () => {
    const tree = [{ description: 'It\'s "quoted"\nand wraps', tags: [MCP_COMMON_PARAMS.evidence] }];
    const first = manifestSource(tree);
    expect(manifestSource(tree)).toEqual(first);
    expect(first.source).toContain(JSON.stringify('It\'s "quoted"\nand wraps'));
    expect(first.source).toContain('MCP_COMMON_PARAMS["evidence"]');
  });

  it("needs no import when no shared text occurs", () => {
    expect(manifestSource([{ description: "nothing shared" }])).toEqual({
      source: JSON.stringify([{ description: "nothing shared" }], null, 2),
      usesCommonParams: false
    });
  });

  it("evaluates back to the tree it was written from", () => {
    const tree = [{ a: MCP_COMMON_PARAMS["dry-run"], b: ["x", { c: MCP_COMMON_PARAMS["expected-version"] }] }];
    const { source } = manifestSource(tree);
    expect(new Function("MCP_COMMON_PARAMS", `return ${source};`)(MCP_COMMON_PARAMS)).toEqual(tree);
  });

  it("is one text with the CLI's COMMON_PARAMS, so the wording cannot split", () => {
    expect(COMMON_PARAMS).toBe(MCP_COMMON_PARAMS);
  });
});
