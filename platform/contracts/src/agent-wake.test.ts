import { describe, expect, it } from "vitest";
import {
  AGENT_WAKE_EVENTS,
  AGENT_WAKE_MARKER,
  AGENT_WAKE_POLICY_EXCEPTION,
  agentWakeDedupeKey,
  agentWakeMessage
} from "./agent-wake.js";
import { agentGoldenRules } from "./agent-policy-text.js";
import { MCP_SERVER_INSTRUCTIONS, MCP_TOOL_MANIFEST } from "./mcp-manifest.js";

const toolNames = new Set(MCP_TOOL_MANIFEST.map((tool) => tool.name));
const tool = (name: string) => MCP_TOOL_MANIFEST.find((entry) => entry.name === name)!;
const properties = (name: string) => Object.keys((tool(name).inputSchema as { properties: object }).properties);

describe("agent wake messages", () => {
  it("start with the marker and carry the id", () => {
    for (const event of AGENT_WAKE_EVENTS) {
      const text = agentWakeMessage(event, "abc-123");
      expect(text.startsWith(AGENT_WAKE_MARKER)).toBe(true);
      expect(text).toContain("abc-123");
      expect(text).not.toContain("${id}");
    }
  });

  it("name only tools that exist", () => {
    for (const event of AGENT_WAKE_EVENTS) {
      const named = agentWakeMessage(event, "x").match(/rhen_[a-z_]+/g) ?? [];
      expect(named.length).toBeGreaterThan(0);
      for (const name of named) expect(toolNames.has(name), `${event} names ${name}`).toBe(true);
    }
  });

  it("write the check-in arguments the tool takes, including its distinct disrupt tool", () => {
    const text = agentWakeMessage("check_in_unanswered", "x");
    for (const arg of ["status", "basis", "evidence", "command-id", "category"]) {
      expect(properties("rhen_check_in")).toContain(arg);
      expect(text).toContain(arg);
    }
    expect(text).toContain("rhen_disrupt ");
    expect(text).not.toContain("rhen_disruption");
  });

  it("write the re-entry arguments the tool takes", () => {
    const text = agentWakeMessage("pulse_lapsed", "x");
    for (const arg of ["location", "energy", "contexts", "basis", "evidence", "settlement-json"]) {
      expect(properties("rhen_reenter")).toContain(arg);
      expect(text).toContain(arg);
    }
  });

  it("write the unknown-pulse arguments the tools take", () => {
    const text = agentWakeMessage("pulse_unknown", "x");
    for (const arg of ["status", "basis", "evidence", "command-id"]) {
      expect(properties("rhen_check_in")).toContain(arg);
      expect(text).toContain(arg);
    }
    expect(text).toContain("rhen_status");
    expect(text).toContain("rhen_disrupt ");
    expect(text).not.toContain("rhen_disruption");
    expect(text).toContain("reentry_required");
  });

  it("covers every event and throws for an unknown one", () => {
    expect([...AGENT_WAKE_EVENTS]).toEqual(["check_in_unanswered", "pulse_lapsed", "pulse_unknown"]);
    expect(() => agentWakeMessage("nope" as never, "x")).toThrow(/Unknown agent wake event/);
  });

  it("never include record text and always say what not to do", () => {
    for (const event of AGENT_WAKE_EVENTS) {
      const text = agentWakeMessage(event, "x");
      expect(text).toContain("ONE short chat message");
      expect(text).toContain("quoted");
      expect(text.toLowerCase()).toContain("guess");
    }
  });

  it("builds a stable dedupe key", () => {
    expect(agentWakeDedupeKey("pulse_lapsed", "2026-11-04T01:00:00.000Z")).toBe(
      "pulse_lapsed:2026-11-04T01:00:00.000Z"
    );
  });
});

describe('the wake exception to "with no one present, do nothing"', () => {
  it("is scoped to a message that begins with the marker and travels in the golden rules and the instructions", () => {
    expect(AGENT_WAKE_POLICY_EXCEPTION).toContain(`begins "${AGENT_WAKE_MARKER}"`);
    expect(AGENT_WAKE_POLICY_EXCEPTION).toContain("with no one present, do nothing");
    expect(agentGoldenRules("the owner")).toContain(AGENT_WAKE_POLICY_EXCEPTION);
    expect(MCP_SERVER_INSTRUCTIONS).toContain(AGENT_WAKE_POLICY_EXCEPTION);
  });
});
