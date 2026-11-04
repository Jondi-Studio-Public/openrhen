import { describe, expect, it } from "vitest";
import { allDirectWritesOn } from "@openrhen/contracts";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/**
 * `rhen agent-token` (owner only), how a write answers when the portal files it as a proposal (202), and
 * the one batch proposal for a large bulk write.
 */
async function run(
  argv: string[],
  routes: Parameters<typeof fakeFetch>[0] = {},
  env: NodeJS.ProcessEnv = {},
  rawState: Record<string, unknown> = fixtureRawState()
) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env,
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: rawState } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const ID = "11111111-1111-4111-8111-111111111111";
const summary = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  name: "companion",
  scopes: ["read:plan", "propose:capture"],
  directWrites: { action: "shadow" },
  expiresAt: "2027-01-16T00:00:00.000Z",
  createdAt: "2026-10-18T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  ...extra
});

describe("agent-token create", () => {
  it("sends the preset's scopes and direct writes, prints the token alone on stdout and warns on stderr", async () => {
    const { exitCode, stdout, stderr, calls } = await run(
      [
        "agent-token",
        "create",
        "--name",
        "companion",
        "--scopes",
        "scribe",
        "--expires-days",
        "30",
        "--direct-writes",
        "action=shadow,project=on"
      ],
      { "/api/agent-tokens": { status: 201, body: { token: "pri_SECRET", agentToken: summary() } } }
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toBe("pri_SECRET");
    expect(stderr).toContain("shown only now");
    expect(stderr).not.toContain("pri_SECRET");
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.path).toBe("/api/agent-tokens");
    expect(post.body).toMatchObject({
      name: "companion",
      expiresInDays: 30,
      directWrites: { action: "shadow", project: "on" }
    });
    expect((post.body as { scopes: string[] }).scopes).toContain("propose:agent-change");
  });

  it("sends every entity class on for --direct-writes on, and nothing for off or no option", async () => {
    const routes = { "/api/agent-tokens": { status: 201, body: { token: "pri_SECRET", agentToken: summary() } } };
    const sent = async (extra: string[]) => {
      const { exitCode, calls } = await run(
        ["agent-token", "create", "--name", "a", "--scopes", "assistant", ...extra],
        routes
      );
      expect(exitCode, extra.join(" ")).toBe(EXIT.ok);
      return (calls.find((call) => call.method === "POST")!.body as { directWrites: Record<string, string> })
        .directWrites;
    };
    expect(await sent(["--direct-writes", "on"])).toEqual(allDirectWritesOn());
    expect(await sent(["--direct-writes", "on,commitment=off"])).toEqual({ ...allDirectWritesOn(), commitment: "off" });
    expect(await sent(["--direct-writes", "off"])).toEqual({});
    expect(await sent([])).toEqual({});
  });

  it("prints both the token and its summary as JSON", async () => {
    const { stdout } = await run(
      ["agent-token", "create", "--name", "a", "--scopes", "read:plan,read:changes", "--json"],
      {
        "/api/agent-tokens": { status: 201, body: { token: "pri_SECRET", agentToken: summary() } }
      }
    );
    expect(JSON.parse(stdout)).toMatchObject({ token: "pri_SECRET", agentToken: { name: "companion" } });
  });

  it("refuses a missing name or scopes, a bad scope and a bad direct-write before sending anything", async () => {
    for (const argv of [
      ["agent-token", "create", "--scopes", "scribe"],
      ["agent-token", "create", "--name", "a"],
      ["agent-token", "create", "--name", "a", "--scopes", "admin:tokens"],
      ["agent-token", "create", "--name", "a", "--scopes", "scribe", "--direct-writes", "settings=on"],
      ["agent-token", "create", "--name", "a", "--scopes", "scribe", "--direct-writes", "action=sometimes"],
      ["agent-token", "create", "--name", "a", "--scopes", "scribe", "--expires-days", "x"]
    ]) {
      const { exitCode, calls } = await run(argv);
      expect(exitCode, argv.join(" ")).toBe(EXIT.usage);
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    }
  });

  it("does not echo the token if the portal's error somehow contains it", async () => {
    const { stderr } = await run(
      ["agent-token", "create", "--name", "a", "--scopes", "scribe"],
      { "/api/agent-tokens": { status: 409, body: { error: "A live token named a exists." } } },
      { OPENRHEN_TOKEN: "pri_ENV" }
    );
    expect(stderr).not.toContain("pri_ENV");
  });
});

describe("agent-token list and revoke", () => {
  it("lists tokens without a secret and marks the state", async () => {
    const { stdout } = await run(["agent-token", "list"], {
      "/api/agent-tokens": {
        body: {
          tokens: [
            summary(),
            summary({ id: "22222222-2222-4222-8222-222222222222", name: "old", revokedAt: "2026-10-01T00:00:00.000Z" })
          ]
        }
      }
    });
    expect(stdout).toContain("companion");
    expect(stdout).toContain("active");
    expect(stdout).toContain("revoked");
    expect(stdout).toContain("action=shadow");
  });

  it("revokes by name, skipping an already revoked token of that name", async () => {
    const { exitCode, stdout, calls } = await run(["agent-token", "revoke", "companion"], {
      "/api/agent-tokens": {
        body: {
          tokens: [
            summary({ id: "22222222-2222-4222-8222-222222222222", revokedAt: "2026-10-01T00:00:00.000Z" }),
            summary()
          ]
        }
      },
      [`/api/agent-tokens/${ID}`]: { body: { agentToken: summary({ revokedAt: "2026-10-18T01:00:00.000Z" }) } }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe(`/api/agent-tokens/${ID}`);
    expect(stdout).toContain("Revoked the token for companion");
  });

  it("answers not-found for an unknown name", async () => {
    const { exitCode } = await run(["agent-token", "revoke", "nobody"], {
      "/api/agent-tokens": { body: { tokens: [] } }
    });
    expect(exitCode).toBe(EXIT.notFound);
  });

  it("is a registry command that is never an MCP tool", () => {
    expect(commands.find((command) => command.name === "agent-token")).toMatchObject({
      mutates: true,
      ownerOnly: true
    });
  });
});

describe("a write the portal files as a proposal", () => {
  const filed = {
    proposal: { id: ID, status: "pending", summary: "Create capture" },
    filedBecause: "directWrites is off for this entity class"
  };

  it("prints that it was filed, exits 0 and records nothing for undo", async () => {
    const { exitCode, stdout, stderr } = await run(["capture", "Book the dentist"], {
      "/api/commands/entity": { status: 202, body: filed }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toContain(`Filed as proposal ${ID}, waiting for the owner`);
    expect(stderr).not.toContain("undo with");
  });

  it("puts the proposal in the JSON output", async () => {
    const { exitCode, stdout } = await run(["capture", "Book the dentist", "--json"], {
      "/api/commands/entity": { status: 202, body: filed }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(JSON.parse(stdout)).toMatchObject({
      filedAsProposal: true,
      message: `Filed as proposal ${ID}, waiting for the owner`,
      proposal: { id: ID }
    });
  });
});

describe("bulk with a token", () => {
  const manyActions = (count: number) => {
    const raw = fixtureRawState();
    const template = (raw.actions as Record<string, unknown>[])[0]!;
    return {
      ...raw,
      actions: Array.from({ length: count }, (_, index) => ({ ...template, id: `bulk-${index}`, version: 1 }))
    };
  };
  const ids = (count: number) => Array.from({ length: count }, (_, index) => `bulk-${index}`).join(",");

  it("files one batch proposal for more than 20 rows instead of a write per row", async () => {
    const { exitCode, stdout, calls } = await run(
      ["bulk", "action", "--ids", ids(25), "--set", "energy=high", "--yes", "--json"],
      {
        "/api/agent-proposals": { status: 201, body: { proposal: { id: ID, status: "pending" }, outcome: "created" } }
      },
      { OPENRHEN_TOKEN: "pri_x" },
      manyActions(25)
    );
    expect(exitCode).toBe(EXIT.ok);
    const writes = calls.filter((call) => call.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/api/agent-proposals");
    const body = writes[0]!.body as { kind: string; summary: string; payload: { commands: { command: string }[] } };
    expect(body.kind).toBe("entity_command_batch");
    expect(body.payload.commands).toHaveLength(25);
    expect(body.payload.commands.every((row) => row.command === "save_action")).toBe(true);
    expect(body.summary.length).toBeLessThanOrEqual(300);
    expect(JSON.parse(stdout)).toMatchObject({ filedAsProposal: true, proposal: { id: ID } });
  });

  it("writes row by row at or under 20 rows, and counts rows the portal filed as proposals", async () => {
    const { exitCode, stdout, calls } = await run(
      ["bulk", "action", "--ids", ids(3), "--set", "energy=high", "--yes", "--json"],
      { "/api/commands/action": { status: 202, body: { proposal: { id: ID }, filedBecause: "x" } } },
      { OPENRHEN_TOKEN: "pri_x" },
      manyActions(3)
    );
    expect(exitCode).toBe(EXIT.ok);
    expect(calls.filter((call) => call.method === "POST" && call.path === "/api/commands/action")).toHaveLength(3);
    expect(JSON.parse(stdout)).toMatchObject({ succeeded: 0, proposed: 3, failed: 0 });
  });

  it("does not batch for a caller with no token", async () => {
    const raw = manyActions(25);
    const { calls } = await run(
      ["bulk", "action", "--ids", ids(25), "--set", "energy=high", "--yes"],
      { "/api/commands/action": () => ({ body: { state: raw } }) },
      {},
      raw
    );
    expect(calls.some((call) => call.path === "/api/agent-proposals")).toBe(false);
    expect(calls.filter((call) => call.path === "/api/commands/action")).toHaveLength(25);
  });
});
