import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderCommandsForMcp } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { serveMcp } from "../src/commands/mcp.js";
import { fakeFetch } from "./fake-fetch.js";
import { fixtureActiveSession, fixtureNow, fixtureRawState } from "./fixture-state.js";

/**
 * Words an MCP agent reads when a call fails (owner rule: an agent never has to guess). Each failure names the field
 * and the value sent, the accepted values or format, and the exact next call, and never speaks in CLI flags.
 */
interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent?: { error?: { message: string; nextCall?: unknown; validValues?: unknown } };
}

async function call(
  name: string,
  args: Record<string, unknown>,
  routes: Parameters<typeof fakeFetch>[0] = {},
  rawState: Record<string, unknown> = fixtureRawState()
): Promise<{ result: ToolResult; message: string; text: string }> {
  const fetchImpl = fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes });
  const written: string[] = [];
  await serveMcp({
    input: [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })],
    write: (line) => written.push(line),
    runner: (argv, capture) =>
      runCli(argv, { ...capture, env: {}, fetchImpl, now: () => fixtureNow, readConfigFile: () => null })
  });
  const result = (JSON.parse(written[0] as string) as { result: ToolResult }).result;
  return {
    result,
    message: result.structuredContent?.error?.message ?? "",
    text: result.content.map((part) => part.text).join("\n")
  };
}

const NO_FLAG = /(^|[\s("'])--[a-z]/;

describe("agent wording: dates and estimates (F1, F5)", () => {
  it("F1: a relative deadline says ISO with the owner's offset, status.now, and to ask when ambiguous", async () => {
    const { message, result } = await call("rhen_save", {
      entityType: "action",
      id: "action-draft",
      fields: { deadlineAt: "next Friday" },
      "dry-run": true
    });
    expect(result.isError).toBe(true);
    expect(message).toContain("deadlineAt");
    expect(message).toContain('"next Friday"');
    expect(message).toMatch(/ISO 8601 date-time with the owner's UTC offset/);
    expect(message).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    expect(message).toContain("status.now");
    expect(message).toMatch(/ask the owner/i);
    expect(message).not.toMatch(/\^\(|regex|\\d/);
  });

  it("F5: an estimate update out of order names the field and says the three estimates go together", async () => {
    const { message } = await call("rhen_save", {
      entityType: "action",
      id: "action-draft",
      fields: { expectedMinutes: 500 },
      "dry-run": true
    });
    expect(message).toContain("expectedMinutes");
    expect(message).toContain("500");
    expect(message).toMatch(/optimisticMinutes, expectedMinutes and pessimisticMinutes together/);
    expect(message).not.toMatch(NO_FLAG);
  });
});

describe("agent wording: no CLI flag syntax in a tool failure (F7, F25)", () => {
  it("F7: an unknown id tells the agent to pass create: true, not --create", async () => {
    const { message } = await call("rhen_save", {
      entityType: "action",
      id: "no-such-action",
      fields: { title: "x" }
    });
    expect(message).toContain('"create": true');
    expect(message).not.toMatch(NO_FLAG);
  });

  it("F7: progress without remaining names the remaining argument", async () => {
    const { message } = await call(
      "rhen_session",
      { subcommand: "finish", outcome: "progress" },
      {},
      { ...fixtureRawState(), ...fixtureActiveSession() }
    );
    expect(message).toMatch(/"remaining"/);
    expect(message).not.toMatch(NO_FLAG);
  });

  it("F25: an unknown place points at rhen_list places, not the shell", async () => {
    const { message } = await call("rhen_arrive", { place: "Atlantis" });
    expect(message).toContain('rhen_list {"entity":"places"');
    expect(message).not.toContain("rhen show");
  });
});

/** Runs a command the way the portal's remote /mcp does (in-process, remote surface), returning stdout and stderr. */
async function runRemote(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    readConfigFile: () => null,
    now: () => fixtureNow,
    remote: true,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes })
  });
  return { exitCode, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("agent wording: dry-run, inbox hints (F2, F17)", () => {
  it("F2: a dry run says exactly what was and was not validated, and that it is not a promise", async () => {
    const { result } = await call("rhen_save", {
      entityType: "action",
      fields: { projectId: "no-such-project", title: "E2E: x" },
      basis: "stated",
      "dry-run": true
    });
    expect(result.isError).toBeFalsy();
    const document = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(document.dryRun).toBe(true);
    expect(String(document.validated)).toMatch(/only/i);
    expect(String(document.validated)).toContain("Nothing was sent");
    const notValidated = (document.notValidated as string[]).join(" | ");
    for (const word of ["ids", "duplicates", "version", "evidence", "scopes"]) expect(notValidated).toContain(word);
    expect(String(document.next)).toContain("without dry-run");
  });

  it("F17: the remote inbox names rhen_inbox_act calls, never the shell's inbox-act", async () => {
    const { exitCode, stdout } = await runRemote(["inbox", "--json"]);
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("inbox-act");
    expect(stdout).toContain('rhen_inbox_act {\\"room\\":\\"captured\\"');
  });

  it("F17: the calendar room on the remote tool says it is the owner's, in the portal, with no shell command", async () => {
    const { stderr, stdout } = await runRemote(["inbox-act", "calendar", "commit", "x", "--json"]);
    const said = `${stderr}${stdout}`;
    expect(said).toContain("Inbox > Calendar");
    expect(said).not.toMatch(/rhen import|--yes/);
  });
});

describe("no MCP-surface failure speaks in CLI flags", () => {
  it("a failure document whose text names flags reaches the agent with arguments instead", async () => {
    const written: string[] = [];
    await serveMcp({
      input: [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "rhen_save", arguments: { entityType: "capture", set: ["text=hi"] } }
        })
      ],
      write: (line) => written.push(line),
      runner: async (_argv, io) => {
        io.stdout(
          JSON.stringify({
            error:
              "--minutes is required. --source must be one of work, family. Pass --create or use --from file.json.",
            exitCode: 2,
            details: null
          })
        );
        return 2;
      }
    });
    const result = (JSON.parse(written[0] as string) as { result: ToolResult }).result;
    const message = result.structuredContent?.error?.message ?? "";
    expect(message).toContain('"minutes" is required');
    expect(message).toContain('"create": true');
    expect(message).not.toMatch(NO_FLAG);
    expect(result.content.map((part) => part.text).join("\n")).not.toMatch(NO_FLAG);
  });

  it("every message the CLI throws, rendered for MCP, has no --flag left", () => {
    const root = join(__dirname, "..", "src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : entry.name.endsWith(".ts") ? [join(dir, entry.name)] : []
      );
    const literal = /(?:new CliError|\busage)\(\s*([`"'])((?:\\.|(?!\1)[^\\])*)\1/g;
    let seen = 0;
    const offenders: string[] = [];
    for (const file of files(root)) {
      for (const match of readFileSync(file, "utf8").matchAll(literal)) {
        seen += 1;
        const rendered = renderCommandsForMcp(match[2]!);
        if (NO_FLAG.test(rendered)) offenders.push(`${file}: ${rendered.slice(0, 90)}`);
      }
    }
    expect(seen).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});

describe("the stdio MCP server speaks in tool calls, the plain CLI keeps CLI wording", () => {
  const SHELL_COMMAND = /\binbox-act\b|\bopenrhen (?!_)[a-z]/;

  it("inbox act hints through the stdio server are rhen_inbox_act calls with no command or flag", async () => {
    const { result, text } = await call("rhen_inbox", {});
    expect(result.isError).toBeFalsy();
    expect(text).toContain("rhen_inbox_act");
    expect(text).not.toMatch(SHELL_COMMAND);
    expect(text).not.toMatch(NO_FLAG);
    expect(text).not.toMatch(/--type|inbox-act|import show/);
  });

  it("inbox act failures through the stdio server name the field and a tool call, never a flag", async () => {
    for (const args of [
      { room: "captured", action: "confirm", id: "no-such-capture" },
      { room: "captured", action: "confirm", id: "capture-1", type: "not-a-type" },
      { room: "nowhere", action: "confirm", id: "x" },
      { room: "map", action: "finding", id: "no-such-finding" }
    ]) {
      const { result, message, text } = await call("rhen_inbox_act", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(message, JSON.stringify(args)).not.toMatch(NO_FLAG);
      expect(message, JSON.stringify(args)).not.toMatch(SHELL_COMMAND);
      expect(text, JSON.stringify(args)).not.toMatch(NO_FLAG);
    }
  });

  it("the plain CLI still prints the CLI's inbox-act command", async () => {
    const out: string[] = [];
    await runCli(["inbox", "--json"], {
      stdout: (text) => out.push(text),
      stderr: () => undefined,
      env: {},
      readConfigFile: () => null,
      now: () => fixtureNow,
      fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } } })
    });
    const text = out.join("\n");
    expect(text).toContain("inbox-act captured confirm --type T|ignore <id>");
    expect(text).not.toContain("rhen_inbox_act");
  });
});

describe("agent wording: disruption duration (issue 776)", () => {
  it.each(["0", "1441"])(
    "duration %s names the field, the accepted forms and the rhen_disruption call",
    async (value) => {
      const { result, message } = await call("rhen_disruption", {
        subcommand: "start",
        title: "Car",
        duration: value
      });
      expect(result.isError).toBe(true);
      expect(message).toContain('"duration"');
      expect(message).toContain(`"${value}"`);
      expect(message).toContain("1 to 1440");
      expect(message).toContain("rest_of_day");
      expect(message).toContain("Call rhen_disruption again");
      expect(message).not.toMatch(NO_FLAG);
    }
  );
});
