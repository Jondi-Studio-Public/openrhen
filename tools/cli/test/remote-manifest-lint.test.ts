import {
  MCP_SERVER_INSTRUCTIONS,
  MCP_TOOL_MANIFEST,
  catchUpEntryVerdictSchema,
  criterionReviewSchema,
  entityCommandPayloadSchema,
  planExtensionSchema,
  planningEntityCommandSchema,
  reentrySettlementSchema,
  workspaceAdditionSchema
} from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { MCP_TOOL_MANIFEST_DATA } from "../../../platform/contracts/src/mcp-manifest-data.js";
import { intentSchema } from "../src/commands/changeset.js";
import { findEntity } from "../src/entities.js";
import { entityCatalogue } from "../src/entities.js";

/**
 * A lint over what a remote agent reads (`tools/list` and `initialize`). An agent must never have to guess how to use
 * a tool, so this fails when a description leaks command-line vocabulary an MCP client cannot use, when a write does
 * not say what it returns, when an argument that takes a fixed set of values does not publish it, or when a
 * JSON-shaped argument has no shape. Fix the text in `tools/cli/src/remote-text.ts` (or the command's own spec), then
 * run `pnpm --filter @openrhen/cli manifest`.
 */
type Property = { type?: string; description?: string; enum?: string[]; properties?: unknown; items?: unknown };

const parameters = (tool: (typeof MCP_TOOL_MANIFEST)[number]) =>
  Object.entries(tool.inputSchema.properties as Record<string, Property>);

/** Open objects that are open on purpose: the kind's own fields are named by the typed save tools and refused with a list. */
const OPEN_OBJECTS = new Set(["rhen_save.fields"]);

describe("the remote tool texts", () => {
  it.each(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool] as const))(
    "%s uses no command-line vocabulary",
    (_name, tool) => {
      const texts = [tool.description, ...parameters(tool).map(([, property]) => property.description ?? "")];
      for (const text of texts) {
        expect(text, "a --flag").not.toMatch(/(?<![\w-])--[a-z]/);
        expect(text, "an exit code").not.toMatch(/\bexit (code )?\d/i);
        expect(text, "output mode").not.toMatch(/\bjq\b|\.json\b|\bprint the (command|payload|request|proposal|rows)/i);
        expect(text, "a shell command").not.toMatch(/\bopenrhen [a-z]/);
        expect(text, "a tool the remote does not serve").not.toMatch(/\bemail-act\b|\bcatch-up-settle\b|`[a-z]+-act`/);
      }
    }
  );

  it.each(MCP_TOOL_MANIFEST.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => [tool.name, tool] as const))(
    "%s says what a call returns",
    (_name, tool) => {
      expect(tool.description).toMatch(/\breturns?\b/i);
    }
  );

  it.each(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool] as const))(
    "%s publishes the values of every argument that takes a fixed set",
    (name, tool) => {
      for (const [param, property] of parameters(tool)) {
        if (property.enum) expect(property.description, `${name}.${param} has an enum but no description`).toBeTruthy();
        if (property.type === "string" && !property.enum && !property.items)
          expect(property.description ?? "", `${name}.${param} lists values with | but has no enum`).not.toMatch(
            /\b[a-z_-]+\|[a-z_-]+\|?/i
          );
      }
    }
  );

  it.each(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool] as const))(
    "%s gives every object argument a shape",
    (name, tool) => {
      for (const [param, property] of parameters(tool)) {
        if (OPEN_OBJECTS.has(`${name}.${param}`)) continue;
        if (property.type === "object") expect(property.properties, `${name}.${param} is a bare object`).toBeDefined();
        if (property.type === "array" && (property.items as Property | undefined)?.type === "object")
          expect((property.items as Property).properties, `${name}.${param} is a bare list of objects`).toBeDefined();
      }
    }
  );

  it("gives each JSON-shaped argument a worked example", () => {
    const shaped: [string, string][] = [
      ["rhen_reenter", "settlement-json"],
      ["rhen_catch_up_settle", "verdicts-json"],
      ["rhen_changeset", "changes"],
      ["rhen_propose", "payload-json"],
      ["rhen_bulk", "targets-json"],
      ["rhen_deliverable", "payload"]
    ];
    for (const [name, param] of shaped) {
      const tool = MCP_TOOL_MANIFEST.find((candidate) => candidate.name === name)!;
      const property = (tool.inputSchema.properties as Record<string, Property>)[param]!;
      expect(`${tool.description}\n${property.description}`, `${name}.${param}`).toMatch(/Example/);
      expect(`${tool.description}\n${property.description}`, `${name}.${param}`).toMatch(/[{[]\s*"/);
    }
  });

  it("publishes the enums the code already enforces", () => {
    const enumOf = (name: string, param: string) =>
      (
        (MCP_TOOL_MANIFEST.find((tool) => tool.name === name)!.inputSchema.properties as Record<string, Property>)[
          param
        ] ?? {}
      ).enum;
    expect(enumOf("rhen_reenter", "energy")).toEqual(["high", "medium", "low", "recovery"]);
    expect(enumOf("rhen_propose", "basis")).toEqual(["stated", "inferred", "observed"]);
    expect(enumOf("rhen_guide", "topic")).toContain("coordinating");
    expect(enumOf("rhen_doctor", "tier")).toEqual(["blocking", "degrading", "tidy"]);
    expect(enumOf("rhen_check_in", "status")).toEqual(["on-track", "deviated", "unknown"]);
    expect(enumOf("rhen_check_in", "category")).toEqual(["work", "family", "life_admin", "other"]);
    expect(enumOf("rhen_search", "mode")).toEqual(["hybrid", "words", "meaning"]);
    expect(enumOf("rhen_session", "subcommand")).toContain("alternative");
    expect(enumOf("rhen_span", "subcommand")).toEqual(["add", "list", "set", "remove"]);
    expect(enumOf("rhen_activity", "subcommand")).toContain("switch-step");
    expect(enumOf("rhen_inbox", "room")).toContain("captured");
    expect(enumOf("rhen_deliverable", "subcommand")).not.toContain("handoff");
  });

  it("does not describe two subcommand lists that disagree", () => {
    const deliverable = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_deliverable")!;
    const subcommand = (deliverable.inputSchema.properties as Record<string, Property>).subcommand!;
    for (const value of subcommand.enum!) expect(subcommand.description).toContain(value);
    expect(subcommand.description).not.toMatch(/handoff|export-sources/);
  });
});

describe("MCP_SERVER_INSTRUCTIONS", () => {
  it("names every group of tools, not a dozen of them", () => {
    const named = new Set(MCP_SERVER_INSTRUCTIONS.match(/\brhen_[a-z_]+/g) ?? []);
    // Typed save tools are covered by rhen_save; a command module's tools describe themselves.
    const coreNames = new Set(MCP_TOOL_MANIFEST_DATA.map((tool) => tool.name));
    const core = MCP_TOOL_MANIFEST.filter((tool) => coreNames.has(tool.name) && !tool.name.startsWith("rhen_save_"));
    expect(core.filter((tool) => !named.has(tool.name)).map((tool) => tool.name)).toEqual([]);
  });

  it("tells a fresh agent what to do first when a call fails with reentry_required", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/reentry_required: call rhen_reenter with no arguments first/);
  });

  it("carries the golden rules and a situation-to-call table", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/never guess/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/same command-id/i);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/startFresh/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/drop_all/);
    expect(MCP_SERVER_INSTRUCTIONS).toMatch(/situation/i);
    expect(MCP_SERVER_INSTRUCTIONS).not.toMatch(/\bhe\b|\bhis\b/);
  });
});

/** Every JSON value that follows the word Example in a text, found by balancing brackets. */
function examplesIn(text: string): unknown[] {
  const found: unknown[] = [];
  for (const match of text.matchAll(/Example[^:{[]*:\s*(?=[{[])/g)) {
    const start = match.index! + match[0].length;
    let depth = 0;
    let inString = false;
    for (let at = start; at < text.length; at++) {
      const char = text[at]!;
      if (inString) {
        if (char === "\\") at++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) {
          found.push(JSON.parse(text.slice(start, at + 1)));
          break;
        }
      }
    }
  }
  return found;
}

/** Every block in a text that opens like JSON (an object or array on a key or string), balanced outside strings. */
function jsonLookingBlocks(text: string): string[] {
  const blocks: string[] = [];
  for (const match of text.matchAll(/[{[]\s*(?=["{]|[A-Za-z_]\w*\s*:)/g)) {
    // An array of objects is judged by its objects and as a whole; a `[` followed by a bare word is prose.
    if (match[0].startsWith("[") && !/^\[\s*["{]/.test(text.slice(match.index!, match.index! + 3))) continue;
    let depth = 0;
    let inString = false;
    for (let at = match.index!; at < text.length; at++) {
      const char = text[at]!;
      if (inString) {
        if (char === "\\") at++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        depth--;
        if (depth === 0) {
          blocks.push(text.slice(match.index!, at + 1));
          break;
        }
      }
    }
    // Never closed: keep what is left so the parse below names it.
    if (depth > 0) blocks.push(text.slice(match.index!));
  }
  return blocks;
}

describe("ended-at", () => {
  it.each(["rhen_session", "rhen_activity"])("%s says a paused session omits it", (name) => {
    const tool = MCP_TOOL_MANIFEST.find((candidate) => candidate.name === name)!;
    expect((tool.inputSchema.properties as Record<string, Property>)["ended-at"]!.description).toMatch(/paused/);
  });
});

describe("every JSON-looking block in a description is valid JSON", () => {
  it.each(MCP_TOOL_MANIFEST.map((tool) => [tool.name, tool] as const))("%s", (name, tool) => {
    const texts: [string, string][] = [
      [name, tool.description],
      ...parameters(tool).map(([param, property]): [string, string] => [`${name}.${param}`, property.description ?? ""])
    ];
    for (const [where, text] of texts)
      // A shape sketch such as {title, required?} carries no string literal and is not a worked example.
      for (const block of jsonLookingBlocks(text).filter((candidate) => candidate.includes('"')))
        expect(
          () => JSON.parse(block),
          `${where}: ${block.slice(0, 80)} is not valid JSON (quote every key)`
        ).not.toThrow();
  });
});

const exampleOf = (tool: string, param: string): unknown[] => {
  const entry = MCP_TOOL_MANIFEST.find((candidate) => candidate.name === tool)!;
  const property = (entry.inputSchema.properties as Record<string, Property>)[param]!;
  return examplesIn(`${entry.description}\n${property.description}`);
};

describe("every worked example parses against the real schema", () => {
  it("reenter settlement-json", () => {
    const examples = exampleOf("rhen_reenter", "settlement-json");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(reentrySettlementSchema.safeParse(example).success).toBe(true);
  });
  it("catch_up_settle verdicts-json", () => {
    const examples = exampleOf("rhen_catch_up_settle", "verdicts-json");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(z.array(catchUpEntryVerdictSchema).safeParse(example).success).toBe(true);
  });
  it("changeset changes", () => {
    const examples = exampleOf("rhen_changeset", "changes");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(z.array(intentSchema).safeParse(example).success).toBe(true);
  });
  it("propose payload-json replays through the real save_entity command", () => {
    const examples = exampleOf("rhen_propose", "payload-json");
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      const payload = entityCommandPayloadSchema.parse(example);
      // The applier adds the proposal's own command id and the command type before it validates the body.
      const command = planningEntityCommandSchema.safeParse({
        type: "save_entity",
        ...payload.body,
        commandId: "3b9c1c6e-7f2a-4c53-9a4e-1d2f3a4b5c6d"
      });
      expect(command.success, JSON.stringify(command.error?.issues)).toBe(true);
    }
  });
  it("bulk targets-json", () => {
    const examples = exampleOf("rhen_bulk", "targets-json");
    expect(examples.length).toBeGreaterThan(0);
    const target = z.object({ id: z.string().min(1), expectedVersion: z.number().int().optional() });
    for (const example of examples) expect(z.array(target).safeParse(example).success).toBe(true);
  });
  it("deliverable payloads, and the manifest shape requires what the contract requires", () => {
    const examples = exampleOf("rhen_deliverable", "payload") as Record<string, unknown>[];
    expect(examples.length).toBeGreaterThanOrEqual(2);
    expect(planExtensionSchema.safeParse(examples.find((example) => "steps" in example)).success).toBe(true);
    expect(criterionReviewSchema.safeParse(examples.find((example) => "summary" in example)).success).toBe(true);
    expect(workspaceAdditionSchema.safeParse(examples[0]).success).toBe(true);
    const deliverable = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_deliverable")!;
    const payload = (deliverable.inputSchema.properties as Record<string, any>).payload;
    expect(payload.properties.steps.items.required).toEqual(["title", "expectedMinutes"]);
  });
});

describe("an enum is never narrower than the command it fronts", () => {
  const enumOf = (tool: string, param: string) =>
    (
      (MCP_TOOL_MANIFEST.find((entry) => entry.name === tool)!.inputSchema.properties as Record<string, Property>)[
        param
      ] ?? {}
    ).enum ?? [];
  it("list entity takes every spelling findEntity does", () => {
    const allowed = enumOf("rhen_list", "entity");
    for (const entity of entityCatalogue)
      for (const spelling of [entity.name, entity.singular, ...entity.aliases]) {
        expect(allowed, spelling).toContain(spelling);
        expect(findEntity(spelling)).toBeDefined();
      }
  });
  it("disrupt exclusive takes everything the command parses", () => {
    expect(enumOf("rhen_disrupt", "exclusive")).toEqual(
      expect.arrayContaining(["true", "false", "yes", "no", "all", "some"])
    );
  });
  it("catch_up_settle bulk takes every bulk the contract names", () => {
    expect(enumOf("rhen_catch_up_settle", "bulk")).toEqual(["all_skipped", "all_dropped", "skip_older_than"]);
  });
});
