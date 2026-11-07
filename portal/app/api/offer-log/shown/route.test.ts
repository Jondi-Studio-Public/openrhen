import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The beacon's framing: the owner gate, body validation, and what reaches the writer. Dedupe itself is the database test's. */
vi.mock("@/server/agent-tokens", () => ({ identifyRequest: async () => ({}) }));
vi.mock("@/server/owner-credential-store", () => ({ findOwnerCredentialByHash: async () => null }));
const env = vi.hoisted(() => ({ url: "postgres://test" as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/pulse/reentry-gate", () => ({ reentryGate: async () => null }));
const writer = vi.hoisted(() => ({ logOfferShown: vi.fn() }));
vi.mock("@/server/persistence/postgres/offer-log-writer", () => writer);

const { POST } = await import("./route");

const CLIENT_ID = "6f1b2a4e-3c5d-4e7f-8a9b-0c1d2e3f4a5b";
const valid = {
  clientId: CLIENT_ID,
  surface: "portal",
  resolutionKind: "commitment",
  targetType: "fixed_commitment",
  targetId: "commitment-1",
  label: "Dentist",
  suppressedBy: { targetType: "action", targetId: "action-1", label: "Write essay" }
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new Request("http://portal.test/api/offer-log/shown", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  env.url = "postgres://test";
  writer.logOfferShown.mockReset().mockResolvedValue(true);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/offer-log/shown", () => {
  it("records a valid event, passing the client id as the command id", async () => {
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: true });
    const [, userId, input] = writer.logOfferShown.mock.calls[0]!;
    expect(userId).toBe("user-1");
    expect(input).toMatchObject({
      surface: "portal",
      resolutionKind: "commitment",
      targetType: "fixed_commitment",
      targetId: "commitment-1",
      commandId: CLIENT_ID,
      suppressedBy: { targetId: "action-1" }
    });
  });

  it("reports a dropped repeat as not recorded, not as an error", async () => {
    writer.logOfferShown.mockResolvedValue(false);
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ recorded: false });
  });

  it.each([
    ["an unknown resolution kind", { ...valid, resolutionKind: "dismissed" }],
    ["a non-portal surface", { ...valid, surface: "handheld" }],
    ["a client id that is not a uuid", { ...valid, clientId: "abc" }],
    ["an unknown field", { ...valid, event: "started" }],
    ["a missing target id", { ...valid, targetId: "" }],
    ["a missing label", { ...valid, label: undefined }],
    ["a body that is not an object", "[1]"],
    ["a body that is not JSON", "{nope"]
  ])("rejects %s with 400 and writes nothing", async (_name, body) => {
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(writer.logOfferShown).not.toHaveBeenCalled();
  });

  it("refuses a caller with no owner credential when owner auth is required", async () => {
    vi.stubEnv("OPENRHEN_OWNER_AUTH", "require");
    vi.stubEnv("PORTAL_PUBLIC_URL", "https://portal.test");
    const response = await post(valid, { origin: "https://portal.test", host: "portal.test" });
    expect([401, 403]).toContain(response.status);
    expect(writer.logOfferShown).not.toHaveBeenCalled();
  });

  it("answers 503 when there is no database", async () => {
    env.url = undefined;
    expect((await post(valid)).status).toBe(503);
  });
});
