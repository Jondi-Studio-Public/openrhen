import { describe, expect, it } from "vitest";
import {
  REFUSAL_KINDS,
  badValueRefusal,
  outOfRangeRefusal,
  requiredRefusal,
  invalidChoiceRefusal,
  listCallFor,
  notFoundRefusal,
  refusalText,
  wrongStateRefusal
} from "./agent-refusal";
import { MCP_TOOL_MANIFEST, mcpManifestTool, validateToolArguments, type McpToolManifestEntry } from "./mcp-manifest";
import type { AgentCall } from "./agent-error";

/** A call an agent can send as it stands: the tool exists, every argument is one it takes, and the schema accepts it. */
export function expectRealCall(call: AgentCall | undefined, label: string): void {
  expect(call, `${label}: a next call`).toBeDefined();
  const tool = mcpManifestTool(call!.tool) as McpToolManifestEntry | undefined;
  expect(tool, `${label}: ${call!.tool} is a tool`).toBeDefined();
  for (const name of Object.keys(call!.arguments))
    expect(Object.hasOwn(tool!.inputSchema.properties, name), `${label}: ${name} is an argument of ${call!.tool}`).toBe(
      true
    );
  const checked = validateToolArguments(tool!.inputSchema, call!.arguments, tool!.name);
  expect(checked.ok, `${label}: ${JSON.stringify(call)} validates (${checked.ok ? "" : checked.error})`).toBe(true);
}

describe("notFoundRefusal", () => {
  it.each(REFUSAL_KINDS)("%s: names the id and a real call that lists the right ones", (kind) => {
    const refusal = notFoundRefusal(kind, "p-123");
    expect(refusal.message).toContain('"p-123"');
    expect(refusal.message).toMatch(/no longer exists, or never existed/);
    if (listCallFor(kind) === undefined) {
      expect(refusal.nextCall).toBeUndefined();
      expect(refusal.message).toContain("Ask the person");
    } else expectRealCall(refusal.nextCall, kind);
  });

  it("a kind with no list of its own gets a search sentence (no nextCall with a placeholder); omits the id when the handler only has a hash", () => {
    const refusal = notFoundRefusal("widget_part", "x");
    expect(refusal.message).toContain("Widget part");
    expect(refusal.nextCall).toBeUndefined();
    expect(refusal.message).toContain('rhen_search, setting "query"');
    expect(JSON.stringify(refusal)).not.toContain("<");
    expect(notFoundRefusal("project", null, "A prerequisite project").message).toBe(
      "A prerequisite project you named no longer exists, or never existed (the id may be wrong)."
    );
    expect(notFoundRefusal("project", "").message).toContain("(none given)");
  });

  it("every listed entity is one rhen_list accepts", () => {
    const list = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_list")!;
    for (const kind of REFUSAL_KINDS) {
      const call = listCallFor(kind);
      if (call?.tool === "rhen_list")
        expect((list.inputSchema.properties.entity as { enum: string[] }).enum).toContain(call.arguments.entity);
    }
  });

  it("refusalText spells the call out for places that return only a message", () => {
    const text = refusalText(notFoundRefusal("project", "p1"));
    expect(text).toContain('Next call: rhen_list {"entity":"projects","limit":20}');
  });
});

describe("wrongStateRefusal", () => {
  it("names the record, its state now, the states accepted and the call that moves it on", () => {
    const refusal = wrongStateRefusal({
      kind: "commitment",
      id: "c1",
      state: "tentative",
      allowed: ["confirmed"],
      nextCall: { tool: "rhen_show", arguments: { entity: "commitment", id: "c1" } }
    });
    expect(refusal.message).toBe(
      'Commitment "c1" is tentative now, so this cannot be done. This command needs it to be confirmed.'
    );
    expect(refusal.validValues).toEqual({ state: ["confirmed"] });
    expectRealCall(refusal.nextCall, "wrong state");
  });

  it("says what the command needs when it is not a list of states", () => {
    expect(
      wrongStateRefusal({ kind: "check-in", id: "k", state: "answered", needs: "a check-in that is still open" })
        .message
    ).toContain("needs a check-in that is still open");
  });
});

describe("invalidChoiceRefusal", () => {
  it("names the field, what was sent and every accepted value, in validValues too", () => {
    const refusal = invalidChoiceRefusal("promptPolicy", "loud", ["silent", "reduced", "normal"], {
      label: "Commitment prompt policy"
    });
    expect(refusal.message).toBe('Commitment prompt policy "loud" is not valid. Use one of: silent, reduced, normal.');
    expect(refusal.validValues).toEqual({ promptPolicy: ["silent", "reduced", "normal"] });
  });

  it("shortens a long list in the text but keeps all of it in validValues, and says when nothing exists yet", () => {
    const many = Array.from({ length: 20 }, (_, index) => `v${index}`);
    const refusal = invalidChoiceRefusal("locationId", "x", many);
    expect(refusal.message).toContain("(and 8 more)");
    expect(refusal.validValues?.locationId).toHaveLength(20);
    expect(invalidChoiceRefusal("locationId", "x", []).message).toContain("Nothing is available to choose from yet");
  });
});

describe("range, shape and required refusals", () => {
  it("outOfRangeRefusal names the field, the value sent, the range with its unit and the way on", () => {
    expect(outOfRangeRefusal("Session break", 500, 0, 120, "minutes").message).toBe(
      "Session break 500 is out of range: send a whole number from 0 to 120 minutes. Repeat the same call with the corrected value."
    );
    expect(outOfRangeRefusal("Retro fallback", 0, 1, 1440, "minutes").message).toContain("1 to 1,440 minutes");
  });

  it("badValueRefusal gives the value sent, what is expected and an example", () => {
    const refusal = badValueRefusal(
      "Period start",
      "tomorrow",
      "it must be a calendar day written YYYY-MM-DD",
      "2026-10-28"
    );
    expect(refusal.message).toBe(
      'Period start "tomorrow" is not valid: it must be a calendar day written YYYY-MM-DD. For example 2026-10-28. Repeat the same call with the corrected value.'
    );
    expect(badValueRefusal("Minutes", undefined, "a whole number").message).toContain("(not given)");
    expect(badValueRefusal("Minutes", 4.5, "a whole number").message).toContain("Minutes 4.5 is not valid");
  });

  it("requiredRefusal says the value was not sent and how to send it", () => {
    expect(requiredRefusal("Project").message).toBe(
      "Project is required but was empty or not sent. Repeat the same call with it set."
    );
    expect(requiredRefusal("Start", "2026-11-04T09:00:00+10:00").message).toContain(
      "For example 2026-11-04T09:00:00+10:00"
    );
  });
});

describe("a title sent where an id belongs (F19)", () => {
  it("says it is a title, not an id, and gives the search and the list that find the id", () => {
    const refusal = notFoundRefusal("project", "Kids: end of semester admin");
    expect(refusal.message).toContain("is not an id");
    expect(refusal.message).toContain("never by title");
    expect(refusal.message).not.toContain("no longer exists");
    expect(refusal.message).toContain('rhen_search {"query":"Kids: end of semester admin"}');
    expect(refusal.message).toContain('rhen_list {"entity":"projects"}');
    expect(refusal.nextCall).toMatchObject({ tool: "rhen_list", arguments: { entity: "projects" } });
  });

  it("still words a missing id the old way", () => {
    expect(notFoundRefusal("project", "p1").message).toContain("no longer exists, or never existed");
  });
});
