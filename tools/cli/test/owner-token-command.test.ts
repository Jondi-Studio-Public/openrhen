import { describe, expect, it } from "vitest";
import { resolveOwnerToken, withoutOwnerToken } from "../src/agent.js";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/errors.js";
import { commands } from "../src/registry.js";
import { fakeFetch, type RecordedCall } from "./fake-fetch.js";
import { fixtureNow, fixtureRawState } from "./fixture-state.js";

/** `rhen owner-token` (owner only), and when the CLI sends X-OpenRhen-Owner. */
async function run(argv: string[], routes: Parameters<typeof fakeFetch>[0] = {}, env: NodeJS.ProcessEnv = {}) {
  const calls: RecordedCall[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(argv, {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    env,
    readConfigFile: () => null,
    now: () => fixtureNow,
    fetchImpl: fakeFetch({ "/api/state": { body: { state: fixtureRawState() } }, ...routes }, calls)
  });
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.join("\n"), calls };
}

const ID = "11111111-1111-4111-8111-111111111111";
const credential = (extra: Record<string, unknown> = {}) => ({
  id: ID,
  kind: "token",
  label: "laptop",
  createdAt: "2026-10-19T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  ...extra
});

describe("owner-token", () => {
  it("create prints the token alone on stdout and warns on stderr", async () => {
    const { exitCode, stdout, stderr, calls } = await run(["owner-token", "create", "--label", "laptop"], {
      "/api/owner/credentials": { status: 201, body: { token: "pri_own_SECRET", credential: credential() } }
    });
    expect(exitCode).toBe(EXIT.ok);
    expect(stdout).toBe("pri_own_SECRET");
    expect(stderr).toContain("shown only now");
    expect(stderr).not.toContain("pri_own_SECRET");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ label: "laptop" });
  });

  it("lists without a secret and revokes by label", async () => {
    const routes = { "/api/owner/credentials": { body: { credentials: [credential()] } } };
    const listed = await run(["owner-token", "list", "--json"], routes);
    expect(JSON.parse(listed.stdout)[0]).toMatchObject({ label: "laptop", state: "active" });
    const revoked = await run(["owner-token", "revoke", "laptop"], {
      ...routes,
      [`/api/owner/credentials/${ID}`]: { body: { credential: credential({ revokedAt: "2026-10-19T01:00:00.000Z" }) } }
    });
    expect(revoked.exitCode).toBe(EXIT.ok);
    expect(revoked.calls.find((call) => call.method === "DELETE")?.path).toBe(`/api/owner/credentials/${ID}`);
    expect((await run(["owner-token", "revoke", "nobody"], routes)).exitCode).toBe(EXIT.notFound);
  });

  it("is a registry command that is never an MCP tool", () => {
    expect(commands.find((command) => command.name === "owner-token")).toMatchObject({
      mutates: true,
      ownerOnly: true
    });
  });
});

describe("X-OpenRhen-Owner", () => {
  const header = async (argv: string[], env: NodeJS.ProcessEnv) => {
    const { calls } = await run(argv, {}, env);
    return calls.find((call) => call.path === "/api/state")?.headers["x-openrhen-owner"];
  };

  it("is sent when OPENRHEN_OWNER_TOKEN is set and the run is not an agent", async () => {
    expect(await header(["status"], { OPENRHEN_OWNER_TOKEN: "pri_own_x" })).toBe("pri_own_x");
    expect(await header(["status"], {})).toBeUndefined();
  });

  it("is never sent by a run that names an agent or holds an agent token", async () => {
    expect(await header(["status", "--agent", "companion"], { OPENRHEN_OWNER_TOKEN: "pri_own_x" })).toBeUndefined();
    expect(
      await header(["status"], { OPENRHEN_OWNER_TOKEN: "pri_own_x", OPENRHEN_AGENT: "companion" })
    ).toBeUndefined();
    expect(await header(["status"], { OPENRHEN_OWNER_TOKEN: "pri_own_x", OPENRHEN_TOKEN: "pri_t" })).toBeUndefined();
    expect(resolveOwnerToken({ OPENRHEN_OWNER_TOKEN: "pri_own_x" }, "companion")).toBeUndefined();
  });

  it("is stripped from the environment an MCP server dispatches with", () => {
    const env = withoutOwnerToken({ OPENRHEN_OWNER_TOKEN: "pri_own_x", OPENRHEN_URL: "http://p" });
    expect(env).toEqual({ OPENRHEN_URL: "http://p" });
  });

  it("is kept out of an error message", async () => {
    const { stderr } = await run(
      ["status"],
      { "/api/state": { status: 401, body: { error: "bad pri_own_x here" } } },
      { OPENRHEN_OWNER_TOKEN: "pri_own_x" }
    );
    expect(stderr).not.toContain("pri_own_x");
  });
});
