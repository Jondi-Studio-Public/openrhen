import { MCP_TOOL_MANIFEST } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

/**
 * What the tool list says must match what the portal does. These pin the sentences an agent acts on (the activity
 * outcomes, the command id, what a disruption changes, the shapes of the two route fields) so a rewrite that
 * drops one fails here. The text lives in `tools/cli/src/remote-text.ts`; regenerate with `pnpm --filter @openrhen/cli manifest`.
 */
type Property = { description?: string; properties?: Record<string, Property> };

const tool = (name: string) => {
  const found = MCP_TOOL_MANIFEST.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};
const property = (name: string, field: string) =>
  (tool(name).inputSchema.properties as Record<string, Property>)[field]!;

describe("rhen_activity text", () => {
  it("limits stopped to a deliverable and skipped to a routine step, naming what else is allowed", () => {
    const text = `${tool("rhen_activity").description} ${property("rhen_activity", "outcome").description}`;
    expect(text).toMatch(/stopped[^.;]*deliverable only/i);
    expect(text).toMatch(/skipped[^.;]*routine_step only/i);
    expect(text).toContain("did_not_start");
  });

  it("says how a commitment is timed and that a start can be backdated", () => {
    const { description } = tool("rhen_activity");
    expect(description).toMatch(/fixed_commitment/);
    expect(description).toMatch(/phase[^.]*rhen_status/);
    expect(description).toContain("started-at");
    expect(description).toContain("24h");
  });
});

describe("command-id text", () => {
  it("says it is optional, that one is made when omitted, and when to resend", () => {
    const writes = MCP_TOOL_MANIFEST.filter((entry) => "command-id" in (entry.inputSchema.properties ?? {}));
    expect(writes.length).toBeGreaterThan(10);
    for (const write of writes) {
      const text = property(write.name, "command-id").description ?? "";
      expect(text, write.name).toMatch(/optional/i);
      expect(text, write.name).toMatch(/omit/i);
      expect(text, write.name).toMatch(/same/i);
      expect(text, write.name).toMatch(/timeout/i);
    }
  });
});

describe("rhen_disrupt text", () => {
  it("says a disruption keeps the pulse on plan and changes nothing else", () => {
    const { description } = tool("rhen_disrupt");
    expect(description).not.toMatch(/routes? around/i);
    expect(description).toMatch(/pulse/i);
    expect(description).toMatch(/does not change the plan, a commitment or the headline/i);
  });
});

describe("the route fields of a saved action", () => {
  const fields = tool("rhen_save_action").inputSchema.properties as Record<string, Property>;
  const action = (fields.fields as Property).properties!;

  it("describes requirementPathways as a list of routes, each a list of condition ids", () => {
    expect(action.requirementPathways!.description).toContain('[["ctx-a"]]');
    expect(action.requirementPathways!.description).toMatch(/condition ids/i);
  });

  it("names the required recurrence fields", () => {
    const text = action.recurrence!.description ?? "";
    for (const name of ["id", "timezone", "startDate", "intervalDays"]) expect(text).toContain(name);
  });
});
