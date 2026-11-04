import { afterEach, describe, expect, it, vi } from "vitest";

const recalculate = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ recalculate }) }));

import { POST } from "./route";

afterEach(() => vi.useRealTimers());

describe("POST /api/commands/recalculate", () => {
  it("plans from the server clock, ignoring a skewed client clock", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-02T03:00:00.000Z"));
    const response = await POST(
      new Request("http://localhost/api/commands/recalculate", {
        method: "POST",
        body: JSON.stringify({
          commandId: "6f1c7a3e-3c1b-4d56-8d7e-0a1b2c3d4e5f",
          type: "recalculate",
          now: "2031-01-01T00:00:00.000Z"
        })
      }),
      { params: Promise.resolve({}) } as never
    );
    expect(response.status).toBe(200);
    expect(recalculate).toHaveBeenCalledWith(expect.objectContaining({ now: "2026-10-02T03:00:00.000Z" }));
  });
});
