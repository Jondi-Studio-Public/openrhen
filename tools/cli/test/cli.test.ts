import { describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../src/cli.js";
import { describeCommand } from "../src/commands/help.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { unreachableFetch, type RecordedCall } from "./fake-fetch.js";

function io(overrides: Partial<CliIo> = {}): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
      env: {},
      fetchImpl: unreachableFetch(),
      now: () => new Date("2026-09-03T09:30:00+10:00"),
      readConfigFile: () => null,
      ...overrides
    }
  };
}

describe("runCli: dispatcher basics", () => {
  it("no args prints the overview and exits ok", async () => {
    const { io: options, stdout } = io();
    const code = await runCli([], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toContain("Commands:");
  });

  it("ignores a leading -- separator, as `pnpm cli -- status` passes it on", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["--", "--version"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toMatch(/^rhen /);
  });

  it("--help prints the overview and exits ok", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["--help"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toContain("Commands:");
  });

  it("-h prints the overview and exits ok", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["-h"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toContain("Commands:");
  });

  it("--version prints the version and exits ok", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["--version"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toBe("rhen 0.1.0");
  });

  it("-v prints the version and exits ok", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["-v"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toBe("rhen 0.1.0");
  });

  it("an option before the command is a usage error", async () => {
    const { io: options, stderr } = io();
    const code = await runCli(["--json", "help"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("rhen:");
    expect(stderr[0]).toContain("--json");
  });

  it("an unknown command is a usage error listing the commands", async () => {
    const { io: options, stderr } = io();
    const code = await runCli(["frobnicate"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain('Unknown command "frobnicate"');
    for (const command of commands) expect(stderr[0]).toContain(command.name);
  });

  it("--help on a command prints that command's help", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["help", "--help"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toContain("Usage: rhen help");
  });
});

describe("runCli: offline commands never resolve config or call fetch", () => {
  it("help --url <public host> succeeds with zero fetch calls", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: new URL(typeof input === "string" ? input : input.toString()).pathname,
        url: String(input),
        headers: {},
        body: null
      });
      throw new Error("should never be called");
    };
    const { io: options, stdout } = io({ fetchImpl });
    const code = await runCli(["help", "--url", "http://example.com"], options);
    expect(code).toBe(EXIT.ok);
    expect(calls).toHaveLength(0);
    expect(stdout[0]).toContain("Commands:");
  });

  it("schema is also offline (declared offline: true even though unimplemented)", () => {
    const schema = commands.find((command) => command.name === "schema");
    expect(schema?.offline).toBe(true);
  });
});

describe("runCli: help command", () => {
  it("help with no positional prints the overview", async () => {
    const { io: options, stdout } = io();
    await runCli(["help"], options);
    expect(stdout[0]).toContain("Commands:");
  });

  it("help <command> prints that command's help", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["help", "list"], options);
    expect(code).toBe(EXIT.ok);
    expect(stdout[0]).toContain("Usage: rhen list");
  });

  it("help <unknown command> is a usage error", async () => {
    const { io: options, stderr } = io();
    const code = await runCli(["help", "frobnicate"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain('Unknown command "frobnicate"');
  });

  it("help --json prints an array with one entry per registry command", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["help", "--json"], options);
    expect(code).toBe(EXIT.ok);
    const parsed = JSON.parse(stdout[0] ?? "[]") as Array<{ name: string }>;
    expect(parsed.map((entry) => entry.name)).toEqual(commands.map((command) => command.name));
  });

  it("help <command> --json prints only that command, not the whole table", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["help", "list", "--json"], options);
    expect(code).toBe(EXIT.ok);
    const parsed = JSON.parse(stdout[0] ?? "null") as { name: string };
    expect(parsed.name).toBe("list");
  });

  it("help <unknown command> --json names the commands instead of dumping the table", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["help", "recurrencee", "--json"], options);
    expect(code).toBe(EXIT.usage);
    expect(stdout.join("")).toContain('Unknown command \\"recurrencee\\"');
    expect(stdout.join("").length).toBeLessThan(5_000);
  });
});

describe("runCli: error rendering", () => {
  // "status" is a connected (non-offline) command with no required positionals; runCli resolves its
  // config, via connectedClient, before spec.run is ever reached, so pointing it at a refused public
  // host exercises the dispatcher's own error path without depending on status's business logic.
  it("table mode prints 'rhen: <message>' to stderr, with pretty details when present", async () => {
    const { io: options, stderr } = io();
    const code = await runCli(["status", "--url", "http://example.com"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]?.startsWith("rhen: ")).toBe(true);
  });

  it("json mode prints a single JSON error object with error, exitCode, and details", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["status", "--url", "http://example.com", "--json"], options);
    expect(code).toBe(EXIT.usage);
    const parsed = JSON.parse(stdout[0] ?? "{}");
    expect(parsed).toHaveProperty("error");
    expect(parsed.exitCode).toBe(EXIT.usage);
    expect(parsed.details).toBeNull();
  });

  it("jsonl mode also prints the JSON error object to stdout", async () => {
    const { io: options, stdout } = io();
    const code = await runCli(["status", "--url", "http://example.com", "--jsonl"], options);
    expect(code).toBe(EXIT.usage);
    const parsed = JSON.parse(stdout[0] ?? "{}");
    expect(parsed.exitCode).toBe(code);
  });

  it("an unrecognised option on a known command is a usage error naming help", async () => {
    const { io: options, stderr } = io();
    const code = await runCli(["help", "--bogus"], options);
    expect(code).toBe(EXIT.usage);
    expect(stderr[0]).toContain("rhen help help");
  });
});

describe("describeCommand", () => {
  it("shape: name, summary, description, mutates, offline, positionals, options, globalOptions, examples", () => {
    const helpSpec = commands.find((command) => command.name === "help");
    expect(helpSpec).toBeDefined();
    const described = describeCommand(helpSpec!);
    expect(described.name).toBe("help");
    expect(described.mutates).toBe(false);
    expect(described.offline).toBe(true);
    expect(Array.isArray(described.positionals)).toBe(true);
    expect(Array.isArray(described.options)).toBe(true);
    expect(Array.isArray(described.globalOptions)).toBe(true);
    expect(described.globalOptions.some((option) => option.name === "json")).toBe(true);
    expect(Array.isArray(described.examples)).toBe(true);
    expect(described.examples.every((example) => example.startsWith("rhen "))).toBe(true);
  });

  it("defaults offline to false when the spec omits it", () => {
    const { offline: _offline, ...withoutOffline } = commands[0]!;
    expect(describeCommand(withoutOffline).offline).toBe(false);
  });
});

describe("runCli: unexpected non-CliError exceptions", () => {
  it("map to exit 5 (unavailable)", async () => {
    const { io: options, stderr } = io({
      readConfigFile: () => {
        throw new Error("disk on fire");
      }
    });
    const code = await runCli(["status"], options);
    expect(code).toBe(EXIT.unavailable);
    expect(stderr[0]).toContain("disk on fire");
  });
});
