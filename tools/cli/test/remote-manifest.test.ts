import { MCP_TOOL_MANIFEST, isKnownScope, requiredScopes } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { toolAnnotations, toolName } from "../src/commands/mcp.js";
import { buildRemoteManifest, remoteTools, REMOTE_TOOLS, type RemoteTool } from "../src/remote-manifest.js";
import { commandModules } from "../src/command-modules.js";
import { commands } from "../src/registry.js";

/**
 * The remote `/mcp` manifest lives in `platform/contracts`, which cannot import this package, and is generated
 * from the registry. This is the other half: it fails when the generated data has drifted from the registry
 * (run `pnpm --filter @openrhen/cli manifest`) or when a tool the remote endpoint must never serve slips in.
 */
describe("the remote MCP manifest", () => {
  it("is exactly what the registry generates", () => {
    expect(MCP_TOOL_MANIFEST).toEqual(buildRemoteManifest(commands));
  });

  it("keeps tools/list under its byte budget", () => {
    // 82,416 bytes when the budget was set (about 5% headroom). Basis, evidence and command-id are described once, on
    // their own parameters, not again in each write tool's description; a new tool or a longer description should
    // justify raising this. Raised from 86,500 on 2026-10-28 for a new tool, rhen_wake (about 1.7 KB): 88,010. Raised to 92,000 on 2026-10-29 for rhen_reenter (about 1.3 KB): 90,833. Raised to 94,500 on 2026-10-29 for rhen_doctor (about 2.2 KB), on top of it. Raised to 97,000 on 2026-10-29 for rhen_disrupt (about 2.1 KB, its shared basis, evidence and command-id parameters included). Raised to 103,000 on 2026-10-30 for rhen_deliverable (about 3.5 KB: 15 arguments, and its description is the only place the subcommands are listed): 100,384. Raised to 110,000 on 2026-11-03 for the agent-facing rewrite (every description says when to call, what it returns and what to do next; real schemas and one worked example for the six JSON arguments; enums for fixed value sets; the common arguments shortened to pay for part of it): 108,816. Raised to 114,000 on 2026-11-03 for the tool-schema findings F11-F27 of the agent end-to-end review (activity preconditions and outcomes, disruption source and duration, propose withdrawal, the week-ahead pointers on summary and history, the fence notes on doctor and inbox): 112,579, 113,001 after merging main. Raised to 116,500 on 2026-11-03 for the wording findings F2, F5 and F10 (what a dry run does and does not check, on every write tool; why an update must send all three estimates; the complete-action shape and the path-naming refusals of rhen_propose): 115,677. The 117,000 cap was already on main after the call-in-answer text (116,746). The true-text pass on proposals (the status line naming wouldChangeIf and the reading-data guide, one sentence on rhen_proposals, and rhen_propose saying to ask the owner to reject instead of restating a record) adds 187 and measures 116,933, so the cap is not raised for it; the next text must shorten existing tool text first. Done on 2026-11-04 for rhen_stretch (about 1.7 KB): shortening the week-ahead pointer, undo, reenter, propose, activity and a few enum-argument texts took main's 115,566 to 115,522 with the tool added, so the cap is unchanged.
    const listed = MCP_TOOL_MANIFEST.map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations
    }));
    expect(Buffer.byteLength(JSON.stringify({ tools: listed }), "utf8")).toBeLessThan(117_000);
  });

  it("keeps the unreachable safe-integer maximum out of the typed save fields", () => {
    const typed = MCP_TOOL_MANIFEST.filter((tool) => tool.fixedArguments?.entityType);
    expect(typed.length).toBeGreaterThan(0);
    for (const tool of typed) expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain("9007199254740991");
  });

  it("maps every tool to a real registry command under the stdio server's own name", () => {
    expect(MCP_TOOL_MANIFEST.length).toBe(remoteTools().length);
    for (const tool of MCP_TOOL_MANIFEST) {
      const spec = commands.find((candidate) => candidate.name === tool.command);
      expect(spec, tool.name).toBeDefined();
      // A typed save tool is `save` with its kind fixed, named for the kind.
      expect(tool.name).toBe(
        tool.fixedArguments?.entityType ? `rhen_save_${tool.fixedArguments.entityType}` : toolName(spec!)
      );
      // The remote list carries the four hints but not `title`: every title repeated the tool's summary, 3,220 bytes of tools/list.
      const { title: _title, ...hints } = toolAnnotations(spec!);
      expect(tool.annotations).toEqual(hints);
      expect(tool.annotations).not.toHaveProperty("title");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("serves the agent tool set the plan names, and no other command", () => {
    expect([...new Set(MCP_TOOL_MANIFEST.map((tool) => tool.command))].sort()).toEqual(
      [
        "archive",
        "cancel",
        "deliverable",
        "status",
        "forecast",
        "summary",
        "list",
        "show",
        "search",
        "map",
        "state",
        "changes",
        "proposals",
        "catch-up",
        "doctor",
        "attention",
        "history",
        "inbox",
        "guide",
        "skill",
        "save",
        "changeset",
        "capture",
        "propose",
        "catch-up-settle",
        "arrive",
        "stretch",
        "wake",
        "session",
        "span",
        "activity",
        "check-in",
        "disruption",
        "routine",
        "recalculate",
        "review",
        "cadence",
        "recurrence",
        "reenter",
        "disrupt",
        "inbox-act",
        "bulk",
        "undo",
        // What a command module serves.
        ...commandModules().flatMap((module) => (module.remoteTools ?? []).map((tool) => tool.command))
      ].sort()
    );
  });

  it("types save: an enum of kinds, a fields object, and a typed tool for each common kind", () => {
    const save = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_save")!;
    const properties = save.inputSchema.properties as Record<string, Record<string, unknown>>;
    expect(properties.entityType?.enum).toEqual(
      expect.arrayContaining([
        "action",
        "sleep_log_entry",
        "settings",
        "sleep-log-entry",
        "routine-step",
        "actions",
        "place"
      ])
    );
    expect(properties.fields?.type).toBe("object");
    expect(properties.create?.type).toBe("boolean");
    for (const kind of ["action", "project", "commitment", "capture"]) {
      const tool = MCP_TOOL_MANIFEST.find((candidate) => candidate.name === `rhen_save_${kind}`)!;
      expect(tool.command).toBe("save");
      expect(tool.fixedArguments).toEqual({ entityType: kind });
      const typed = tool.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(typed.entityType).toBeUndefined();
      expect(typed.set).toBeUndefined();
      expect(typed.fields?.type).toBe("object");
      expect(Object.keys(typed.fields?.properties as object)).toContain(kind === "capture" ? "text" : "title");
      expect(typed.fields?.required).toBeUndefined();
    }
    const action = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_save_action")!;
    const fields = (
      action.inputSchema.properties as unknown as Record<
        string,
        { properties: Record<string, Record<string, unknown>> }
      >
    ).fields!;
    expect(fields.properties?.expectedMinutes?.type).toBe("integer");
    expect(fields.properties?.status?.enum as string[]).toContain("done");
    expect(fields.properties?.completedAt).toBeDefined();
  });

  it("gives the numeric options real number types", () => {
    const list = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_list")!;
    expect(list.inputSchema.properties.limit).toMatchObject({ type: "integer", minimum: 1 });
    const map = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_map")!;
    expect(map.inputSchema.properties.depth).toMatchObject({ type: "integer", minimum: 1, maximum: 4 });
    const propose = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_propose")!;
    expect(propose.inputSchema.properties["payload-json"]).toMatchObject({ type: "object" });
  });

  it("serves no owner-only command, no outward one but the rooms' own actions, and no local-file option", () => {
    const ownerOnly = commands.filter((spec) => spec.ownerOnly).map((spec) => spec.name);
    expect(ownerOnly).toEqual(expect.arrayContaining(["agent-token", "owner-token"]));
    const served = MCP_TOOL_MANIFEST.map((tool) => tool.command);
    for (const name of [...ownerOnly, "mcp", "import", "email-draft", "self-update", "schema", "help", "version"])
      expect(served, name).not.toContain(name);
    for (const tool of MCP_TOOL_MANIFEST) {
      const spec = commands.find((candidate) => candidate.name === tool.command)!;
      // `inbox-act` can reply to another person, which the portal holds on the hard floor for any agent.
      if (spec.outward === true) expect(spec.name, tool.name).toBe("inbox-act");
      for (const [name, option] of Object.entries(spec.options))
        if (option.localPath) expect(tool.inputSchema.properties, `${tool.name} ${name}`).not.toHaveProperty(name);
    }
  });

  it("lists the scopes the tool's routes ask for, so it is never shown to a token that would only be refused", () => {
    const scopes = (command: string) => MCP_TOOL_MANIFEST.find((tool) => tool.command === command)!.scopes;
    expect(scopes("arrive")).toEqual(expect.arrayContaining(["write:entity:current_availability", "read:plan"]));
    // A stretch answer waives the energy cut, so it takes the scope energy itself is set with; the offer is read from status.
    expect(scopes("stretch")).toEqual(["write:entity:current_availability", "read:plan"]);
    expect(scopes("disruption")).toEqual(expect.arrayContaining(["write:entity:commitment", "write:activity"]));
    expect(scopes("routine")).toEqual(expect.arrayContaining(["write:entity:commitment"]));
    // The wake is the sleep log's fact, so it takes the sleep log's scope and nothing else.
    expect(scopes("wake")).toEqual(["write:entity:sleep_log_entry"]);
    // Re-entry is the one call allowed while lapsed, and its read is served under its own scope.
    expect(scopes("reenter")).toEqual(["write:catch-up"]);
    // ...and read by any token that can only propose, so it is listed for them (answers still need write:catch-up).
    expect(MCP_TOOL_MANIFEST.find((tool) => tool.command === "reenter")!.readableWithAnyOf).toEqual([
      "read:plan",
      "write:catch-up",
      "propose:catch-up"
    ]);
    // Every command that reads the plan before it writes says so; the ones that never read it do not.
    for (const tool of MCP_TOOL_MANIFEST)
      if (
        !tool.annotations.readOnlyHint &&
        !["propose", "catch-up-settle", "recalculate", "wake", "reenter"].includes(tool.command)
      )
        expect(tool.scopes, tool.name).toContain("read:plan");
  });

  it("serves undo for the agent's own writes only: no --any-owner, no --force", () => {
    const undo = MCP_TOOL_MANIFEST.find((tool) => tool.command === "undo")!;
    expect(Object.keys(undo.inputSchema.properties).sort()).toEqual(
      ["basis", "dry-run", "evidence", "id", "list", "redo"].sort()
    );
    // Each undo sends its own fresh write, so a repeat is not deduplicated: no command-id, and not idempotent (as no write is).
    expect(undo.annotations.idempotentHint).toBe(false);
    expect(undo.description).not.toMatch(/--any-owner|--force|--redo|rhen undo/);
    expect(undo.description).toMatch(/pass id/);
    expect(undo.scopes).toEqual(expect.arrayContaining(["write:undo"]));
  });

  it("leaves out the options that only make sense on the machine running the CLI", () => {
    for (const tool of MCP_TOOL_MANIFEST) {
      const names = Object.keys(tool.inputSchema.properties);
      for (const machineOnly of ["url", "timeout", "allow-public", "state-file", "read-only", "jsonl", "pretty"])
        expect(names, `${tool.name} ${machineOnly}`).not.toContain(machineOnly);
      // `changes` is the one command whose own `agent` is a filter, not the caller's name.
      if (tool.command !== "changes") expect(names, tool.name).not.toContain("agent");
    }
    const bulk = MCP_TOOL_MANIFEST.find((tool) => tool.command === "bulk")!;
    expect(Object.keys(bulk.inputSchema.properties)).toEqual(expect.arrayContaining(["ids", "targets-json", "set"]));
    expect(Object.keys(bulk.inputSchema.properties)).not.toEqual(expect.arrayContaining(["targets"]));
    expect(Object.keys(bulk.inputSchema.properties)).not.toContain("patch");
  });

  it("names a known scope for each tool: a read scope for a read, the scope table's for a write", () => {
    for (const tool of MCP_TOOL_MANIFEST) {
      for (const scope of tool.scopes) expect(isKnownScope(scope), `${tool.name} ${scope}`).toBe(true);
      if (tool.command === "guide" || tool.command === "skill") {
        // Static text: nothing to protect, so any authenticated token may read it.
        expect(tool.scopes).toEqual([]);
      } else if (tool.annotations.readOnlyHint) {
        expect(tool.scopes.length, tool.name).toBeGreaterThan(0);
        expect(
          tool.scopes.every((s) => s.startsWith("read:")),
          tool.name
        ).toBe(true);
      } else if (tool.command === "save" || tool.command === "bulk") {
        // The entity type decides the real scope; the broad propose scope is what a scribe token holds.
        expect(tool.scopes, tool.name).toEqual(["propose:entity", "read:plan"]);
      } else {
        // The tool's own scope, then whatever else its routes ask for (a state read, the entity a save writes).
        expect(tool.scopes, tool.name).toEqual(expect.arrayContaining(requiredScopes({ tool: tool.command })));
      }
    }
  });

  it("serves the skill with no scope, and without the stdio-only remote flag", () => {
    const skill = MCP_TOOL_MANIFEST.find((tool) => tool.name === "rhen_skill")!;
    expect(skill.scopes).toEqual([]);
    expect(skill.inputSchema.properties).toHaveProperty("flavour");
    expect(skill.inputSchema.properties).not.toHaveProperty("remote");
    expect(skill.annotations.readOnlyHint).toBe(true);
  });

  describe("a renamed tool's aliases", () => {
    const table: RemoteTool[] = [
      ...REMOTE_TOOLS.filter((tool) => tool.command === "status"),
      { command: "list", scopes: ["read:plan"], aliases: ["rhen_ls", "rhen_old_list"] }
    ];

    it("are extra manifest entries running the same command, with the same schema and scopes", () => {
      const built = buildRemoteManifest(commands, table);
      expect(built.map((tool) => tool.name)).toEqual(["rhen_status", "rhen_list", "rhen_ls", "rhen_old_list"]);
      const [, current, alias] = built;
      expect(alias).toMatchObject({
        command: "list",
        inputSchema: current!.inputSchema,
        scopes: current!.scopes,
        annotations: current!.annotations
      });
      expect(alias!.description).toBe(
        `Renamed to rhen_list; this name goes away in the next contract version. ${current!.description}`
      );
      expect(current!.description).not.toContain("Renamed to");
    });

    it("refuse a name that is already served", () => {
      expect(() => buildRemoteManifest(commands, [{ command: "list", scopes: [], aliases: ["rhen_list"] }])).toThrow(
        /twice/
      );
    });
  });
});
