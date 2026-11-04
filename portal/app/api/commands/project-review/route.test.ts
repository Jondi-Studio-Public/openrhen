import { describe, expect, it, vi } from "vitest";

const confirmProjectWanted = vi.hoisted(() => vi.fn(async () => ({ projects: [] })));
vi.mock("@/server/persistence/state-store", () => ({ getStateStore: () => ({ confirmProjectWanted }) }));

import { POST } from "./route";

const post = (body: unknown) =>
  POST(new Request("http://localhost/api/commands/project-review", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({})
  } as never);

describe("POST /api/commands/project-review", () => {
  it("passes a valid confirm to the store and answers with the state", async () => {
    const response = await post({ projectId: "p1", expectedVersion: 2 });
    expect(response.status).toBe(200);
    expect(confirmProjectWanted).toHaveBeenCalledWith({ projectId: "p1", expectedVersion: 2 });
    expect(await response.json()).toEqual({ state: { projects: [] } });
  });

  it("passes kind through, and refuses one it does not know", async () => {
    confirmProjectWanted.mockClear();
    const response = await post({ projectId: "p1", expectedVersion: 2, kind: "overdue_seen", reviewedAt: null });
    expect(response.status).toBe(200);
    expect(confirmProjectWanted).toHaveBeenCalledWith({
      projectId: "p1",
      expectedVersion: 2,
      kind: "overdue_seen",
      reviewedAt: null
    });
    confirmProjectWanted.mockClear();
    expect((await post({ projectId: "p1", expectedVersion: 2, kind: "other" })).status).toBe(400);
    expect(confirmProjectWanted).not.toHaveBeenCalled();
  });

  it("refuses a body without a version or a project", async () => {
    confirmProjectWanted.mockClear();
    expect((await post({ projectId: "p1" })).status).toBe(400);
    expect((await post({ expectedVersion: 2 })).status).toBe(400);
    expect((await post({ projectId: "p1", expectedVersion: null })).status).toBe(400);
    expect(confirmProjectWanted).not.toHaveBeenCalled();
  });
});
