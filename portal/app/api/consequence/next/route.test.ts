import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://test" as string | undefined }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const read = vi.hoisted(() => vi.fn());
vi.mock("@/server/persistence/postgres/consequence-commands", () => ({ readNextConsequenceGroup: read }));

import { GET } from "./route";

const get = (query = "") =>
  GET(new Request(`http://localhost/api/consequence/next${query}`), { params: Promise.resolve({}) } as never);

beforeEach(() => {
  env.url = "postgres://test";
  read.mockReset().mockResolvedValue({ groupId: "g1", items: [] });
});

describe("GET /api/consequence/next", () => {
  it("returns the group, never cached, and varies by who asks", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ group: { groupId: "g1", items: [] } });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("vary")).toContain("X-OpenRhen-Agent");
    expect(read).toHaveBeenCalledWith(expect.anything(), {});
  });

  it("limits to one pool when asked, and refuses any other value", async () => {
    await get("?pool=action");
    expect(read).toHaveBeenCalledWith(expect.anything(), { pool: "action" });
    const bad = await get("?pool=deliverable");
    expect(bad.status).toBe(400);
    const badError = ((await bad.json()) as { error: string }).error;
    expect(badError).toContain("project");
    expect(badError).toContain('rhen_inbox {"room":"compare"}');
  });

  it("answers null when nothing can be asked", async () => {
    read.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ group: null });
  });

  it("says plainly when the portal has no database", async () => {
    env.url = undefined;
    const response = await get();
    expect(response.status).toBe(503);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("PostgreSQL");
    expect(error).toContain("retry");
    expect(error).toContain('rhen_inbox {"room":"compare"}');
  });
});
