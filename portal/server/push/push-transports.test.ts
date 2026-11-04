import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushTransports, registerPushTransport, unregisterPushTransport } from "./push-transports";

const sql = {} as never;

vi.mock("@/server/persistence/postgres/ensure-user", () => ({ ensureUser: async () => "user-1" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => sql }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("./push-drain", () => ({ runPushDrain: async () => ({ claimed: 2, sent: 2 }) }));

const { POST } = await import("@/app/api/integrations/push/drain/route");
const drain = () => (POST as (request: Request, context: unknown) => Promise<Response>)(new Request("http://x"), {});

describe("the push_transport registry", () => {
  let saved: ReturnType<typeof pushTransports>;
  beforeEach(() => {
    saved = pushTransports();
    for (const transport of saved) unregisterPushTransport(transport.id);
  });
  afterEach(() => {
    for (const transport of pushTransports()) unregisterPushTransport(transport.id);
    for (const transport of saved) registerPushTransport(transport);
  });

  it("drains Web Push alone when no transport is registered", async () => {
    expect(pushTransports()).toEqual([]);
    const response = await drain();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimed: 2, sent: 2 });
  });

  it("reports each registered transport under its id, and a failing one beside the Web Push result", async () => {
    registerPushTransport({
      id: "fake_ok",
      drain: async (_sql, userId) => ({ ran: userId }),
      failingDevices: async () => []
    });
    registerPushTransport({
      id: "fake_bad",
      drain: async () => {
        throw new Error("the transport broke");
      },
      failingDevices: async () => []
    });
    const response = await drain();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      claimed: 2,
      sent: 2,
      fake_ok: { ran: "user-1" },
      fake_bad: { error: "the transport broke" }
    });
  });

  it("replaces a transport registered twice under one id", () => {
    const transport = { drain: async () => ({}), failingDevices: async () => [] };
    registerPushTransport({ id: "twice", ...transport });
    registerPushTransport({ id: "twice", ...transport });
    expect(pushTransports().map((t) => t.id)).toEqual(["twice"]);
  });
});
