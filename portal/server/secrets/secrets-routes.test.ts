import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three secret routes through `withRoute`: the preconditions on writing, what each answer carries, and that the
 * value being saved never reaches a log line or a response. The owner gate and the store are stand-ins; the
 * sealing, policy, validation and logging are the real ones.
 */
const store = vi.hoisted(() => ({
  putSecret: vi.fn(),
  deleteSecret: vi.fn(),
  secretStatuses: vi.fn()
}));
vi.mock("@/server/persistence/postgres/app-secrets-store", () => store);
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({
  ensureUser: async () => "11111111-1111-4111-8111-111111111111"
}));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgresql://u:p@localhost/db" }));
vi.mock("@/server/owner-auth", async (original) => ({
  ...(await original<typeof import("@/server/owner-auth")>()),
  ownerGate: async () => ({ owner: true })
}));

const VALUE = "AIzaSy-SUPER-SECRET-VALUE-123";
const KEY = randomBytes(32).toString("base64");

const { GET } = await import("@/app/api/settings/secrets/route");
const { PUT, DELETE } = await import("@/app/api/settings/secrets/[name]/route");

const ctx = (name = "youtube_data_api_key") => ({ params: Promise.resolve({ name }) });
const put = (body: string, name?: string) =>
  PUT(new Request("http://portal.test/api/settings/secrets/x", { method: "PUT", body }), ctx(name));

let logged: string[];
beforeEach(() => {
  logged = [];
  vi.stubEnv("PORTAL_PUBLIC_URL", "http://portal.test");
  vi.stubEnv("OPENRHEN_SECRETS_KEY", KEY);
  vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
  for (const method of ["log", "error", "warn", "info"] as const)
    vi.spyOn(console, method).mockImplementation((...args) => void logged.push(args.join(" ")));
  store.putSecret.mockReset().mockResolvedValue({ updatedAt: new Date("2026-11-06T03:00:00.000Z") });
  store.deleteSecret.mockReset().mockResolvedValue(true);
  store.secretStatuses
    .mockReset()
    .mockResolvedValue([
      { name: "youtube_data_api_key", isSet: true, updatedAt: "2026-11-06T03:00:00.000Z", state: "set" }
    ]);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("writes need a master key and owner sign-in", () => {
  it("refuses with 409 and the exact steps when neither is configured, and stores nothing", async () => {
    vi.stubEnv("OPENRHEN_SECRETS_KEY", "");
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "off");
    const response = await put(JSON.stringify({ value: VALUE }));
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; masterKeyConfigured: boolean; ownerAuthRequired: boolean };
    expect(body.error).toContain("OPENRHEN_SECRETS_KEY");
    expect(body.error).toContain("OPENRHEN_OWNER_AUTH=require");
    expect(body.error).toContain("openssl rand -base64 32");
    expect(body).toMatchObject({ masterKeyConfigured: false, ownerAuthRequired: false });
    expect(JSON.stringify(body)).not.toContain(VALUE);
    expect(store.putSecret).not.toHaveBeenCalled();
  });

  it("refuses when only owner sign-in is missing, and when only the master key is missing", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "shadow");
    const ownerOnly = await put(JSON.stringify({ value: VALUE }));
    expect(ownerOnly.status).toBe(409);
    expect(((await ownerOnly.json()) as { error: string }).error).not.toContain("OPENRHEN_SECRETS_KEY");
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    vi.stubEnv("OPENRHEN_SECRETS_KEY", "too-short");
    const keyOnly = await put(JSON.stringify({ value: VALUE }));
    expect(keyOnly.status).toBe(409);
    const error = ((await keyOnly.json()) as { error: string }).error;
    expect(error).toContain("OPENRHEN_SECRETS_KEY");
    expect(error).not.toContain("too-short");
    expect(store.putSecret).not.toHaveBeenCalled();
  });

  it("also refuses to remove a key without them", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "off");
    const response = await DELETE(
      new Request("http://portal.test/api/settings/secrets/x", { method: "DELETE" }),
      ctx()
    );
    expect(response.status).toBe(409);
    expect(store.deleteSecret).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("seals and stores the value and answers with status only", async () => {
    const response = await put(JSON.stringify({ value: VALUE }));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      name: "youtube_data_api_key",
      isSet: true,
      updatedAt: "2026-11-06T03:00:00.000Z",
      state: "set"
    });
    expect(text).not.toContain(VALUE);
    expect(store.putSecret.mock.calls[0]![3]).toBe(VALUE);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects an unknown name with 404 naming the allowed ones, and a bad body with 400", async () => {
    const unknown = await put(JSON.stringify({ value: VALUE }), "openai_api_key");
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error: string }).error).toContain("youtube_data_api_key");
    for (const body of [
      "",
      "not json",
      JSON.stringify({ value: "" }),
      JSON.stringify({ value: VALUE, extra: 1 }),
      JSON.stringify([VALUE])
    ]) {
      const response = await put(body);
      expect(response.status, body).toBe(400);
      expect(await response.text()).not.toContain(VALUE);
    }
    const huge = await put(JSON.stringify({ value: "x".repeat(20_000) }));
    expect(huge.status).toBe(413);
    expect(store.putSecret).not.toHaveBeenCalled();
  });
});

describe("the value is never logged", () => {
  it("leaves it out of every log line on success, on refusal and on bad input", async () => {
    await put(JSON.stringify({ value: VALUE }));
    await put(`{"value": "${VALUE}", "extra": true}`);
    await put(VALUE);
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "off");
    await put(JSON.stringify({ value: VALUE }));
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(VALUE);
  });

  it("logs a failed save without the driver's message, which can quote the value", async () => {
    store.putSecret.mockRejectedValue(new Error(`insert failed for value ${VALUE} password=${VALUE}`));
    const response = await put(JSON.stringify({ value: VALUE }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(VALUE);
    expect(logged.join("\n")).not.toContain(VALUE);
    expect(logged.join("\n")).toContain("/api/settings/secrets/[name]");
  });

  it("logs the route template and the command type, not the secret's name or the body", async () => {
    await put(JSON.stringify({ value: VALUE }));
    const line = JSON.parse(logged.find((entry) => entry.includes("save_secret"))!) as Record<string, unknown>;
    expect(line).toMatchObject({
      route: "/api/settings/secrets/[name]",
      method: "PUT",
      commandType: "save_secret",
      status: 200
    });
    expect(Object.keys(line).sort()).toEqual([
      "commandType",
      "durationMs",
      "level",
      "message",
      "method",
      "route",
      "status"
    ]);
  });
});

describe("status", () => {
  it("lists names, state and dates, and whether saving is possible, never a value", async () => {
    const response = await GET(new Request("http://portal.test/api/settings/secrets"), undefined);
    const body = await response.json();
    expect(body).toEqual({
      masterKeyConfigured: true,
      ownerAuthRequired: true,
      canWrite: true,
      secrets: [{ name: "youtube_data_api_key", isSet: true, updatedAt: "2026-11-06T03:00:00.000Z", state: "set" }]
    });
    vi.stubEnv("OPENRHEN_SECRETS_KEY", "");
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "off");
    const off = (await (await GET(new Request("http://portal.test/api/settings/secrets"), undefined)).json()) as Record<
      string,
      unknown
    >;
    expect(off).toMatchObject({ masterKeyConfigured: false, ownerAuthRequired: false, canWrite: false });
  });
});

describe("removing", () => {
  it("works without a valid master key, needing only owner sign-in", async () => {
    for (const key of ["", "too-short"]) {
      store.deleteSecret.mockClear();
      vi.stubEnv("OPENRHEN_SECRETS_KEY", key);
      const response = await DELETE(
        new Request("http://portal.test/api/settings/secrets/x", { method: "DELETE" }),
        ctx()
      );
      expect(response.status).toBe(200);
      expect(store.deleteSecret).toHaveBeenCalledOnce();
    }
  });

  it("names only owner sign-in when it refuses", async () => {
    vi.stubEnv("OPENRHEN_SECRETS_KEY", "");
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "off");
    const response = await DELETE(
      new Request("http://portal.test/api/settings/secrets/x", { method: "DELETE" }),
      ctx()
    );
    expect(response.status).toBe(409);
    const error = ((await response.json()) as { error: string }).error;
    expect(error).toContain("OPENRHEN_OWNER_AUTH=require");
    expect(error).not.toContain("OPENRHEN_SECRETS_KEY");
  });

  it("removes a saved key and answers with status only", async () => {
    const response = await DELETE(
      new Request("http://portal.test/api/settings/secrets/x", { method: "DELETE" }),
      ctx()
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "youtube_data_api_key", isSet: false, state: "unset" });
    expect(store.deleteSecret).toHaveBeenCalledOnce();
  });
});
