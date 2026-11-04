import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  conflictMessage,
  doubtfulWriteMessage,
  committedWriteMessage,
  hardFloorReason,
  readFailureMessage,
  rateLimitMessage,
  renderCommandsForMcp,
  unknownToolMessage,
  scopesForRoute,
  mcpManifestTool
} from "@openrhen/contracts";
import "@/server/drop-ins";

/**
 * Contract for the words an agent is served when a call fails: an
 * agent has tools, not a shell and not a Reload button. The owner's own terminal commands (`agent-token`,
 * `owner-token`) are for the person to run and are the one allowed exception.
 */
const OWNER_COMMAND = /`rhen (agent-token|owner-token) [^`]*`/g;
const withoutOwnerCommands = (text: string) => text.replace(OWNER_COMMAND, "");

function expectNoShellForm(text: string, label: string) {
  const plain = withoutOwnerCommands(text);
  expect(plain, `${label}: a --flag`).not.toMatch(/(^|\s)--[a-z][a-z-]*/);
  expect(plain, `${label}: a openrhen shell command`).not.toMatch(/`rhen [a-z]/);
  expect(plain, `${label}: the word Reload`).not.toMatch(/\bReload\b/);
  expect(plain, `${label}: gendered`).not.toMatch(/\b(he|his|him)\b/i);
}

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts") && !/\.test\./.test(entry.name)
        ? [join(dir, entry.name)]
        : []
  );

describe("text an agent is served on a failure", () => {
  it("no agent-served source tells a caller to Reload", () => {
    const roots = [
      __dirname,
      join(__dirname, "..", "..", "platform", "contracts", "src"),
      join(__dirname, "..", "..", "tools", "cli", "src")
    ];
    const offenders = roots.flatMap(sourceFiles).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file, line: line.trim(), index }))
        .filter(({ line }) => /Reload/.test(line) && !line.startsWith("*") && !line.startsWith("//"))
        .map(({ file: path, index }) => `${path}:${index + 1}`)
    );
    expect(offenders).toEqual([]);
  });

  it("the shared retry and conflict messages carry no flag, no Reload and no shell command", () => {
    for (const [label, text] of Object.entries({
      doubtful: doubtfulWriteMessage("The request failed.", "id-1", "rhen_save"),
      committed: committedWriteMessage("Saved.", "id-1", "rhen_save"),
      read: readFailureMessage("The request failed.", "rhen_list"),
      conflict: conflictMessage("It changed.", "rhen_save", 4),
      rate: rateLimitMessage(30),
      unknown: unknownToolMessage("rhen_nope", ["rhen_status"])
    }))
      expectNoShellForm(text, label);
  });

  it("the 403 and 202 texts the enforcement layer serves, and the scope refusal, carry no shell form, flag or he/his", async () => {
    const { enforceAgentRequest } = await import("./agent-enforcement");
    const principal = (scopes: string[]) => ({ name: "agent", source: "db" as const, scopes, directWrites: {} });
    const ask = (method: string, route: string, scopes: string[], body?: unknown) =>
      enforceAgentRequest(
        new Request(`http://portal.test${route}`, {
          method,
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        }),
        route,
        principal(scopes) as never,
        {},
        { stored: async () => ({}) }
      );
    const refusals = [
      await ask("GET", "/api/changes", ["read:plan"]),
      await ask("POST", "/api/agent-proposals/x/resolve", ["write:entity:action"], {}),
      await ask("DELETE", "/api/imports/x", ["write:import"], {}),
      await ask("POST", "/api/commands/entity", ["write:entity:action"], {
        type: "save_entity",
        entityType: "widget",
        entity: {}
      }),
      await ask("GET", "/api/brand-new", ["read:plan"])
    ];
    for (const response of refusals) {
      expect(response).not.toBeNull();
      const { error } = (await response!.json()) as { error: string };
      expectNoShellForm(renderCommandsForMcp(error), error.slice(0, 40));
    }
  });

  it("every hard-floor refusal, rendered for MCP, names a tool call or the person, never a shell command", () => {
    const floors = [
      { tool: "span", action: "remove" },
      { tool: "save", entityType: "sleep_log_entry", remove: true },
      { tool: "save", entityType: "action", remove: true },
      { tool: "save", entityType: "capture", remove: true },
      { tool: "import", action: "delete" },
      { tool: "recurrence", action: "end", entityType: "action" },
      { tool: "recurrence", action: "end" },
      { tool: "inbox-act", room: "kept", action: "drop" }
    ] as const;
    for (const floor of floors) {
      const text = renderCommandsForMcp(hardFloorReason(floor as never) ?? "");
      expect(text, JSON.stringify(floor)).not.toBe("");
      expectNoShellForm(text, JSON.stringify(floor));
    }
  });

  it("every refusal the route table gives, rendered for MCP, has no shell command or flag", () => {
    const refusals = [
      scopesForRoute("POST", "/api/commands/entity", {
        type: "save_entity",
        entityType: "capture",
        entity: { status: "confirmed" }
      }),
      scopesForRoute("POST", "/api/agent-proposals/[id]/resolve"),
      scopesForRoute("POST", "/api/commands/entity", { entityType: "mystery" }),
      scopesForRoute("POST", "/api/brand-new")
    ];
    for (const decision of refusals) {
      expect(decision.kind).toBe("refused");
      if (decision.kind === "refused") expectNoShellForm(renderCommandsForMcp(decision.message), decision.reason);
    }
  });
});

/**
 * The refusals a command handler throws reach an agent as the text of a tool failure. Each family has one helper in
 * `command-errors.ts` (`notFound`, `wrongState`, `invalidChoice`, `versionConflict`, `openSessionConflict`) that names the
 * id or value, the valid ones and the exact next call, so a throw site must not word those cases by hand.
 */
describe("command handler refusals are built by the shared helpers", () => {
  const dir = join(__dirname, "persistence", "postgres");
  const handlers = readdirSync(dir).filter((name) => name.endsWith(".ts") && !/\.test\./.test(name));
  const BANNED: [RegExp, string][] = [
    [/no longer exists|does not exist/i, "a gone record: throw notFound(kind, id)"],
    [/\bChoose (the|another|at least|no more)\b/, "UI voice: say which argument to send"],
    [/\bReload\b/, "there is no Reload for an agent"],
    [/\bSelect a\b/, "UI voice: say which argument to send"],
    [/must be between \d/, "a range: throw outOfRange(label, got, min, max, unit)"],
    [/is out of range\./, "a range: throw outOfRange(label, got, min, max, unit)"],
    [/`save [a-z-]+`|`rhen [a-z]/, "a shell command: write the tool call, rhen_save {...}"],
    [/Redo puts it back/, 'an undo refusal: name the call, rhen_undo {"id":...,"redo":true}'],
    [/Ask them to /, "say who does it: Tell the person to ..., or the call the agent makes"],
    [/Read it again/, "a version conflict: throw versionConflict(kind, id, expected, actual)"],
    [
      /\b(status|state|source|category|policy|presence|origin|attendance|kind|portability|energy|mode|method|channel|uncertainty) is invalid/i,
      "an enum: throw invalidChoice(field, got, validValues)"
    ]
  ];

  it("no throw of a command error words a gone record, UI voice or a bare enum refusal by hand", () => {
    const offenders: string[] = [];
    for (const name of handlers) {
      const lines = readFileSync(join(dir, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!/new (InvalidCommandError|CommandConflictError|ForbiddenCommandError|NotFoundCommandError)\(/.test(line))
          return;
        const call = lines.slice(index, index + 3).join(" ");
        for (const [pattern, why] of BANNED) if (pattern.test(call)) offenders.push(`${name}:${index + 1} ${why}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("the deliverable workspace, its stores and the proposal store word a gone record through the shared text", () => {
    const files = [
      join(__dirname, "deliverables", "workspace-moves.ts"),
      join(__dirname, "agent-proposals", "store.ts"),
      join(dir, "deliverable-chat-store.ts"),
      join(dir, "deliverable-proposal-store.ts"),
      join(dir, "import-store.ts")
    ];
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /new (Error|AgentProposalError|ImportConflictError)\(/.test(line))
        .filter(({ line }) => /no longer exists|does not exist|not found\./i.test(line))
        .map(({ index }) => `${file}:${index + 1}`)
    );
    expect(offenders).toEqual([]);
    expect(readFileSync(files[0]!, "utf8")).toContain('notFoundRefusal("deliverable", deliverableId)');
  });

  it("the helpers are used: the handlers use them at least as often as they did when converted (a ratchet, not a target)", () => {
    // Extensions the public export leaves out say so on their first line; skipping them makes the count the same in both trees.
    const count = (word: RegExp) =>
      handlers.reduce((sum, name) => {
        const text = readFileSync(join(dir, name), "utf8");
        return text.startsWith("// @left-out-of-export") ? sum : sum + (text.match(word) ?? []).length;
      }, 0);
    expect(count(/\bnotFound(Conflict)?\(/g)).toBeGreaterThanOrEqual(51);
    expect(count(/\binvalidChoice\(/g)).toBeGreaterThanOrEqual(30);
    expect(count(/\bversionConflict\(/g)).toBeGreaterThanOrEqual(16);
    expect(count(/\b(outOfRange|badValue|requiredValue)\(/g)).toBeGreaterThanOrEqual(39);
    expect(count(/\b(wrongState|wrongSessionState|alreadyClosed|openSessionConflict)\(/g)).toBeGreaterThanOrEqual(21);
  });
});

/**
 * A route answers a missing record in one of two ways: `notFoundResponse(kind, id)`, which names the id and the call that
 * lists the right ones, or a hand-worded sentence. A hand-worded one is allowed only on a route no agent token may call
 * (`scopesForRoute` refuses it as owner-only), so the owner-only claim is pinned here rather than assumed.
 */
describe("hand-worded not-found sentences sit only on owner-only routes", () => {
  const appRoot = join(__dirname, "..", "app");
  const routeFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? routeFiles(path) : entry === "route.ts" ? [path] : [];
    });
  const SENTENCE = /error:\s*"[^"]*(not found|does not exist|no longer exists)[^"]*"/i;

  it("every route that still words one by hand is refused to agents for every method it exports", () => {
    const offenders: string[] = [];
    let handWorded = 0;
    for (const root of ["api", "mcp", "oauth"]) {
      for (const file of routeFiles(join(appRoot, root))) {
        const source = readFileSync(file, "utf8");
        if (!SENTENCE.test(source)) continue;
        handWorded += 1;
        const template = `/${relative(appRoot, join(file, "..")).split(sep).join("/")}`;
        for (const method of source.matchAll(
          /export\s+(?:const|async\s+function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g
        )) {
          const decision = scopesForRoute(method[1]!, template, {} as never);
          if (decision.kind !== "refused") offenders.push(`${method[1]} ${template} (${decision.kind})`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(handWorded).toBeGreaterThan(0);
  });
});

/**
 * Handlers build some `nextCall`s by hand (read the open session, list the routines, show the commitment). Each one is read
 * out of the source here and held to the manifest: the tool exists, every argument is one the tool takes, and a literal
 * `entity` or `subcommand` is a value the tool's own schema allows.
 */
describe("every hand-built nextCall in the handlers is a call the manifest accepts", () => {
  const sources = [
    ...readdirSync(join(__dirname, "persistence", "postgres"))
      .filter((name) => name.endsWith(".ts") && !/\.test\./.test(name))
      .map((name) => join(__dirname, "persistence", "postgres", name)),
    join(__dirname, "deliverables", "workspace-moves.ts"),
    join(__dirname, "agent-proposals", "store.ts")
  ];
  const CALL = /tool:\s*"(rhen_[a-z_]+)"\s*,\s*arguments:\s*\{([^{}]*)\}/g;
  const found = sources.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(CALL)].map((match) => ({
      file: file.split("server")[1]!,
      tool: match[1]!,
      body: match[2]!
    }))
  );

  it("finds the hand-built calls (inbox, show, status, routine and context lists, session and activity)", () => {
    const tools = new Set(found.map((call) => call.tool));
    for (const tool of ["rhen_inbox", "rhen_show", "rhen_status", "rhen_list", "rhen_session", "rhen_activity"])
      expect(tools.has(tool), tool).toBe(true);
    expect(found.some((call) => /routine-presets/.test(call.body))).toBe(true);
    expect(found.some((call) => /condition-definitions/.test(call.body))).toBe(true);
  });

  it("each names a real tool, only arguments it takes, and enum values it allows", () => {
    for (const call of found) {
      const tool = mcpManifestTool(call.tool);
      expect(tool, `${call.file}: ${call.tool} is a tool`).toBeDefined();
      for (const key of call.body.matchAll(/(?:^|[,{\s])("?)([A-Za-z][\w-]*)\1\s*:/g)) {
        const name = key[2]!;
        const property = tool!.inputSchema.properties[name] as { enum?: string[] } | undefined;
        expect(property, `${call.file}: ${name} is an argument of ${call.tool}`).toBeDefined();
        const literal = new RegExp(`"?${name}"?\\s*:\\s*"([^"$]+)"`).exec(call.body)?.[1];
        if (literal !== undefined && property?.enum)
          expect(property.enum, `${call.file}: ${name}=${literal} for ${call.tool}`).toContain(literal);
      }
    }
  });
});
