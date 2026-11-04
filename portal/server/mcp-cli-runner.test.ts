import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeLogActor, requestClaim } from "./agent-actor";
import type { AgentPrincipal } from "./agent-tokens";
import { IN_PROCESS_ORIGIN, cliEnvironment, createInProcessFetch, runCliInProcess } from "./mcp-cli-runner";
import type { RouteModule } from "./mcp-route-table";

const { withRoute } = await import("./logging");

interface Seen {
  route: string;
  url: string;
  headers: Headers;
  actor: string | null;
  claim: ReturnType<typeof requestClaim>;
  params?: unknown;
}
const seen: Seen[] = [];
const stub = (route: string, respond: () => Response = () => Response.json({ ok: true })) =>
  withRoute(route, async (request: Request, context: { params?: Promise<unknown> } | undefined) => {
    await request.text();
    seen.push({
      route,
      url: request.url,
      headers: request.headers,
      actor: changeLogActor(),
      claim: requestClaim(),
      params: await context?.params
    });
    return respond();
  });

const routes: Record<string, RouteModule> = {
  "/api/state": { GET: stub("/api/state", () => Response.json({ state: { areas: [], settings: {} } })) },
  "/api/commands/entity": {
    POST: stub("/api/commands/entity", () => Response.json({ state: { captures: [{ id: "c1", text: "x" }] } }))
  },
  "/api/imports/[id]": { GET: stub("/api/imports/[id]", () => Response.json({ batch: { id: "b1" } })) }
};
const loadRoute = async (template: string) => routes[template];

const principal = (scopes: string[]): AgentPrincipal => ({
  name: "companion",
  source: "db",
  tokenId: "t1",
  scopes,
  directWrites: {}
});
const inbound = () => new Request("https://portal.test/mcp", { method: "POST", headers: { host: "portal.test" } });
const agent = (scopes: string[]) => ({ kind: "agent" as const, principal: principal(scopes) });

beforeEach(() => {
  // The default host allowlist is closed: admit the host these tests send.
  vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
  seen.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the in-process fetch", () => {
  const fetchFor = () =>
    createInProcessFetch({ actor: agent(["read:plan", "propose:capture"]), inbound: inbound(), loadRoute });

  it("refuses any URL whose origin is not the in-process one", async () => {
    const fetchImpl = fetchFor();
    for (const url of [
      "https://evil.test/api/state",
      "http://127.0.0.1:8787/api/state",
      "https://openrhen.localhost/api/state",
      "http://openrhen.localhost:8080/api/state",
      "http://openrhen.localhost.evil.test/api/state",
      "http://user@evil.test/api/state"
    ])
      await expect(fetchImpl(url), url).rejects.toThrow(/refused/);
    expect(seen).toHaveLength(0);
  });

  it("answers a path outside the route table 404 without running anything", async () => {
    const fetchImpl = fetchFor();
    for (const path of ["/mcp", "/oauth/token", "/.well-known/oauth-protected-resource", "/api/nope", "/api/state/x"]) {
      const response = await fetchImpl(`${IN_PROCESS_ORIGIN}${path}`);
      expect(response.status, path).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("answers a method the route does not export 405", async () => {
    const response = await fetchFor()(`${IN_PROCESS_ORIGIN}/api/state`, { method: "DELETE" });
    expect(response.status).toBe(405);
  });

  it("passes only the headers a route reads, never the CLI's token or owner headers", async () => {
    const response = await fetchFor()(`${IN_PROCESS_ORIGIN}/api/commands/entity`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "X-OpenRhen-Basis": "stated",
        "X-OpenRhen-Evidence": "words",
        "X-OpenRhen-Token": "pri_stolen",
        "X-OpenRhen-Owner": "owner-secret",
        "X-OpenRhen-Agent": "someone-else",
        Authorization: "Bearer x",
        Cookie: "openrhen_owner=abc"
      },
      body: JSON.stringify({ type: "save_entity", entityType: "capture", entity: { text: "x", status: "pending" } })
    });
    expect(response.status).toBe(200);
    const call = seen[0]!;
    expect(call.headers.get("x-openrhen-basis")).toBe("stated");
    for (const name of ["x-openrhen-token", "x-openrhen-owner", "x-openrhen-agent", "authorization", "cookie"])
      expect(call.headers.has(name), name).toBe(false);
    // Addressed as the inbound caller addressed this server.
    expect(call.headers.get("host")).toBe("portal.test");
    expect(call.url).toBe("https://portal.test/api/commands/entity");
    expect(call.actor).toBe("companion");
  });

  it("hands a dynamic route its params", async () => {
    await fetchFor()(`${IN_PROCESS_ORIGIN}/api/imports/b%2F1`);
    expect(seen[0]!.params).toEqual({ id: "b/1" });
  });

  it("refuses a body that is not text", async () => {
    await expect(
      fetchFor()(`${IN_PROCESS_ORIGIN}/api/commands/entity`, { method: "POST", body: new Uint8Array([1]) })
    ).rejects.toThrow(/text/);
  });
});

describe("the CLI's environment", () => {
  it("holds only the in-process portal and the agent's name, never the server's own", () => {
    vi.stubEnv("OPENRHEN_OWNER_TOKEN", "owner-secret");
    vi.stubEnv("DATABASE_URL", "postgres://secret");
    const env = cliEnvironment(agent([]));
    expect(Object.keys(env).sort()).toEqual(["OPENRHEN_AGENT", "OPENRHEN_TOKEN", "OPENRHEN_URL"]);
    expect(env.OPENRHEN_URL).toBe(IN_PROCESS_ORIGIN);
    expect(env.OPENRHEN_AGENT).toBe("companion");
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(cliEnvironment({ kind: "owner" })).toEqual({ OPENRHEN_URL: IN_PROCESS_ORIGIN });
  });
});

describe("runCliInProcess", () => {
  it("runs a real command against the route handlers as the token's agent", async () => {
    vi.stubEnv("OPENRHEN_OWNER_TOKEN", "owner-secret");
    vi.stubEnv("OPENRHEN_URL", "https://evil.test");
    const result = await runCliInProcess({
      argv: ["capture", "--basis=stated", "--evidence=they said so", "--json", "--", "Book the dentist"],
      actor: agent(["read:plan", "propose:capture"]),
      inbound: inbound(),
      loadRoute
    });
    expect(result.exitCode).toBe(0);
    expect(result.failed).toBe(false);
    const write = seen.find((call) => call.route === "/api/commands/entity")!;
    expect(seen.every((call) => call.actor === "companion")).toBe(true);
    expect(write.claim).toEqual({ basis: "stated", evidence: "they said so" });
    expect(write.url.startsWith("https://portal.test/")).toBe(true);
    for (const call of seen)
      for (const name of ["x-openrhen-token", "x-openrhen-owner"]) expect(call.headers.has(name)).toBe(false);
  });

  it("is the remote run: state needs a key, and JSON comes back compact", async () => {
    const refused = await runCliInProcess({
      argv: ["state", "--json"],
      actor: agent(["read:plan"]),
      inbound: inbound(),
      loadRoute
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr.join("") + refused.stdout.join("")).toContain("rhen_status");
    const keyed = await runCliInProcess({
      argv: ["state", "--key=areas", "--json"],
      actor: agent(["read:plan"]),
      inbound: inbound(),
      loadRoute
    });
    expect(keyed.exitCode).toBe(0);
    expect(keyed.stdout.join("")).toBe("[]");
  });

  it("reports the scopes a token lacks when a route answers 403 with them", async () => {
    const result = await runCliInProcess({
      argv: ["capture", "--json", "--", "x"],
      actor: agent(["read:plan"]),
      inbound: inbound(),
      loadRoute
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.insufficientScopes).toEqual(["propose:capture"]);
    expect(seen.map((call) => call.route)).not.toContain("/api/commands/entity");
  });

  it("reports a route that threw as a failure to run, not a refusal", async () => {
    const result = await runCliInProcess({
      argv: ["state", "--key=areas", "--json"],
      actor: agent(["read:plan"]),
      inbound: inbound(),
      loadRoute: async () => {
        throw new Error("cannot load");
      }
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.failed).toBe(true);
  });

  it("reaches no file: a state file and the config file are unavailable", async () => {
    const result = await runCliInProcess({
      argv: ["state", "--state-file=/etc/hostname", "--json"],
      actor: agent(["read:plan"]),
      inbound: inbound(),
      loadRoute
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout.join("") + result.stderr.join("")).toContain("not available");
    expect(seen).toHaveLength(0);
  });
});

describe("an owner actor", () => {
  it("passes owner auth under `require` with no credential, which the same request off the wire does not", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    const wire = await routes["/api/state"]!.GET!(
      new Request("https://portal.test/api/state", { headers: { host: "portal.test" } }),
      undefined as never
    );
    expect(wire.status).toBe(401);
    const result = await runCliInProcess({
      argv: ["state", "--key=areas", "--json"],
      actor: { kind: "owner" },
      inbound: inbound(),
      loadRoute
    });
    expect(result.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    // The person, not an agent: no actor name is stamped.
    expect(seen[0]!.actor).toBeNull();
  });

  it("does not turn an agent into the owner", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    const result = await runCliInProcess({
      argv: ["state", "--key=areas", "--json"],
      actor: agent(["read:plan"]),
      inbound: inbound(),
      loadRoute
    });
    expect(result.exitCode).toBe(0);
    expect(seen[0]!.actor).toBe("companion");
  });
});
