import { createHash, randomBytes } from "node:crypto";
import type { JournalEntry } from "@openrhen/cli/in-process";
import type { JournalStore } from "./agent-journal-runner";
import type { RouteLoader } from "./mcp-cli-runner";
import type { RouteModule } from "./mcp-route-table";
import type { StoredAgentToken } from "./agent-token-store";
import { createFailureThrottle } from "./agent-token-throttle";
import { generateAccessToken, hashAccessToken, type StoredAccessToken } from "./mcp-access-tokens";
import type { OauthDeps } from "./mcp-oauth";
import type { OauthClient, StoredAuthorizationCode, StoredRefreshToken } from "./mcp-oauth-store";

/** Shared by the remote MCP tests: in-memory stand-ins for the agent token and access token tables. */
export const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export const NOW = new Date("2026-10-19T00:00:00Z");
export const SECRET = "pri_secret-for-the-companion";
export const RESOURCE = "https://portal.test/mcp";

export const agentRecord = (extra: Partial<StoredAgentToken> = {}): StoredAgentToken => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "companion",
  tokenHash: sha(SECRET),
  scopes: ["read:plan", "read:changes", "propose:capture"],
  directWrites: {},
  expiresAt: new Date("2027-01-01T00:00:00Z"),
  revokedAt: null,
  ...extra
});

/** An in-memory stand-in for the two tables, behaving as the real queries do. */
export function fakeDeps(agents: StoredAgentToken[] = [agentRecord()], now = NOW) {
  const access = new Map<string, StoredAccessToken>();
  const clients = new Map<string, OauthClient>();
  const codes = new Map<string, StoredAuthorizationCode>();
  const refresh = new Map<string, StoredRefreshToken>();
  const revoked: string[] = [];
  const limits = { maxClients: 100 };
  const clock = { now };
  const deps: OauthDeps = {
    findAgentToken: async (hash) => agents.find((agent) => agent.tokenHash === hash) ?? null,
    mintAccessToken: async ({ agent, resource, scopes }) => {
      const token = generateAccessToken();
      const expiresAt = new Date(Math.min(clock.now.getTime() + 3_600_000, agent.expiresAt.getTime()));
      access.set(hashAccessToken(token), {
        id: "22222222-2222-4222-8222-222222222222",
        agentTokenId: agent.id,
        resource,
        scopes,
        expiresAt,
        agent
      });
      return { token, expiresAt, scopes };
    },
    findAccessToken: async (hash) => access.get(hash) ?? null,
    findClient: async (clientId) => clients.get(clientId) ?? null,
    registerClient: async ({ clientName, redirectUris }) => {
      if (clients.size >= limits.maxClients) {
        const full = new Error("The client store is full.");
        full.name = "OauthStoreFull";
        throw full;
      }
      const client = {
        clientId: `pri_client_${randomBytes(16).toString("base64url")}`,
        clientName,
        redirectUris,
        createdAt: clock.now
      };
      clients.set(client.clientId, client);
      return client;
    },
    // As the real query: the row as it was before this call, with consumed_at set afterwards.
    consumeAuthorizationCode: async (hash) => {
      const row = codes.get(hash);
      if (!row) return null;
      const before = { ...row };
      row.consumedAt ??= clock.now;
      return before;
    },
    issueRefreshToken: async ({ clientId, agent, resource, scopes }) => {
      const token = `pri_rt_${randomBytes(32).toString("base64url")}`;
      const expiresAt = new Date(Math.min(clock.now.getTime() + 30 * 86_400_000, agent.expiresAt.getTime()));
      refresh.set(sha(token), {
        id: `rt-${refresh.size + 1}`,
        clientId,
        agentTokenId: agent.id,
        resource,
        scopes,
        expiresAt,
        usedAt: null,
        agent
      });
      return { token, expiresAt };
    },
    useRefreshToken: async (hash) => {
      const row = refresh.get(hash);
      if (!row) return null;
      const before = { ...row };
      row.usedAt ??= clock.now;
      return before;
    },
    revokeAgentToken: async (id) => {
      revoked.push(id);
      for (const agent of agents) if (agent.id === id) agent.revokedAt = clock.now;
      for (const row of [...access.values(), ...codes.values(), ...refresh.values()])
        if (row.agent.id === id) row.agent = { ...row.agent, revokedAt: clock.now };
    },
    throttle: createFailureThrottle(),
    now: () => clock.now
  };
  return { deps, access, clock, clients, codes, refresh, revoked, limits };
}

/** Seeds an authorization code (as `POST /oauth/authorize` would) and returns it with the matching PKCE verifier. */
export function seedCode(
  fakes: ReturnType<typeof fakeDeps>,
  extra: Partial<StoredAuthorizationCode> & { clientId?: string; agent?: StoredAgentToken } = {}
) {
  const verifier = randomBytes(32).toString("base64url");
  const code = `pri_code_${randomBytes(16).toString("base64url")}`;
  const agent = extra.agent ?? agentRecord();
  const clientId = extra.clientId ?? "pri_client_test";
  const redirectUri = "http://127.0.0.1:8123/callback";
  fakes.clients.set(clientId, { clientId, clientName: "Test", redirectUris: [redirectUri], createdAt: NOW });
  fakes.codes.set(sha(code), {
    id: "code-1",
    clientId,
    agentTokenId: agent.id,
    redirectUri,
    codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
    resource: RESOURCE,
    scopes: ["read:plan", "propose:capture"],
    expiresAt: new Date(fakes.clock.now.getTime() + 120_000),
    consumedAt: null,
    agent,
    ...extra
  });
  return { code, verifier, clientId, redirectUri };
}

export const codeRequest = (fields: Record<string, string>) =>
  tokenRequest({ grant_type: "authorization_code", client_id: "", client_secret: "", resource: "", ...fields });

export const tokenRequest = (fields: Record<string, string> = {}, headers: Record<string, string> = {}) => {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: "companion",
    client_secret: SECRET,
    resource: RESOURCE,
    ...fields
  });
  for (const [name, value] of Object.entries(fields)) if (value === "") body.delete(name);
  return new Request("https://portal.test/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", host: "portal.test", ...headers },
    body
  });
};
export const mcpRequest = (token?: string, headers: Record<string, string> = {}) =>
  new Request("https://portal.test/mcp", {
    method: "POST",
    headers: { host: "portal.test", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }
  });

/** A server-checked journal entry as the ledger rebuilds one: undo and redo post the write id to the revert route. */
export const serverCheckedEntry = (id: string, extra: Partial<JournalEntry> = {}): JournalEntry => ({
  id,
  at: "2026-10-27T00:00:00.000Z",
  label: `update area "Old"`,
  undo: { path: "/api/commands/revert", payload: { target: id, direction: "undo" } },
  redo: { path: "/api/commands/revert", payload: { target: id, direction: "redo" } },
  target: { stateKey: "revert", id },
  status: "applied",
  serverChecked: true,
  ...extra
});

/** An in-memory, load-only journal store: `rows` holds the entries a test seeds for each agent (the ledger's, in life). */
export function fakeJournalStore() {
  const rows = new Map<string, JournalEntry[]>();
  const calls = { loads: 0 };
  const store: JournalStore = {
    load: async (agent) => {
      calls.loads += 1;
      return structuredClone(rows.get(agent) ?? []);
    }
  };
  return { store, rows, calls };
}

/**
 * A tiny portal for the undo tests: one area that `save area` can rename, behind the real route wrapper, so a
 * write is attributed and version-checked by the real CLI exactly as it is in production; its revert route only records.
 */
export async function fakeWorld() {
  const { withRoute } = await import("./logging");
  const { changeLogActor } = await import("./agent-actor");
  const area = { id: "a1", name: "Old", status: "active", sortOrder: 0, version: 1 };
  /** A second record, so a test can have the agent write somewhere the owner's undo did not touch. */
  const other = { id: "a2", name: "Other", status: "active", sortOrder: 1, version: 1 };
  const areaFor = (entity: Record<string, unknown>) => (entity.id === other.id ? other : area);
  const posts: { actor: string | null; body: Record<string, unknown> }[] = [];
  /** What reached the revert route (a server-checked undo or redo), and whether the next one is refused as a conflict. */
  const reverts: { actor: string | null; body: Record<string, unknown> }[] = [];
  const revertRefusal: { status?: number } = {};
  const snapshot = () => ({
    state: {
      settings: { timezone: "Australia/Sydney" },
      areas: [{ ...area }, { ...other }],
      captures: [],
      projects: []
    }
  });
  const routes: Record<string, RouteModule> = {
    "/api/state": { GET: withRoute("/api/state", async () => Response.json(snapshot())) },
    "/api/commands/entity": {
      POST: withRoute("/api/commands/entity", async (request: Request) => {
        const body = (await request.json()) as {
          expectedVersion: number | null;
          entity: Record<string, unknown>;
        };
        posts.push({ actor: changeLogActor(), body });
        const target = areaFor(body.entity);
        if (body.expectedVersion !== target.version)
          return Response.json({ error: "That record changed since it was read." }, { status: 409 });
        Object.assign(target, body.entity, { version: target.version + 1 });
        return Response.json(snapshot());
      })
    },
    "/api/commands/revert": {
      POST: withRoute("/api/commands/revert", async (request: Request) => {
        reverts.push({ actor: changeLogActor(), body: (await request.json()) as Record<string, unknown> });
        if (revertRefusal.status)
          return Response.json({ error: "That record changed since it was read." }, { status: revertRefusal.status });
        return Response.json({ ok: true });
      })
    }
  };
  const loadRoute: RouteLoader = async (template) => routes[template];
  return { area, other, posts, reverts, revertRefusal, routes, loadRoute };
}
