import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `POST /api/push/subscriptions` framing for the new-device rules (security review W3): what each store
 * outcome maps to. The store itself
 * (cap, announcement, refresh vs add) is covered by push-subscriptions.integration.test.ts.
 */
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));

const store = vi.hoisted(() => ({ addPushSubscription: vi.fn(), MAX_PUSH_SUBSCRIPTIONS: 5 }));
vi.mock("@/server/push/push-subscriptions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/push/push-subscriptions")>()),
  addPushSubscription: store.addPushSubscription
}));

const { POST } = await import("./route");

const body = {
  subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: "p", auth: "a" } },
  vapidPublicKey: "key",
  label: "iPhone"
};
const post = (payload: unknown = body) =>
  new Request("http://portal.test/api/push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
const handler = POST as (request: Request, context: unknown) => Promise<Response>;
const call = (request: Request) => handler(request, { params: Promise.resolve({}) });

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgres://test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  store.addPushSubscription.mockReset().mockResolvedValue("added");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/push/subscriptions", () => {
  it.each(["added", "refreshed"])("answers 200 when the store reports %s", async (outcome) => {
    store.addPushSubscription.mockResolvedValue(outcome);
    expect((await call(post())).status).toBe(200);
    expect(store.addPushSubscription).toHaveBeenCalledTimes(1);
  });

  it("answers 409 with a remove-a-device message when the cap is reached", async () => {
    store.addPushSubscription.mockResolvedValue("cap_reached");
    const response = await call(post());
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toMatch(/5 notification devices.*Remove one/);
  });

  it("rejects an endpoint off the push-host allowlist before anything is stored", async () => {
    const response = await call(
      post({ ...body, subscription: { ...body.subscription, endpoint: "https://evil.example/x" } })
    );
    expect(response.status).toBe(400);
    expect(store.addPushSubscription).not.toHaveBeenCalled();
  });
});
