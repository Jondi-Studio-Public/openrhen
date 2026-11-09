import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://example" as string | undefined }));
const reasons = vi.hoisted(() => ({ saveReason: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/drift/drift-reasons", () => reasons);

const route = await import("./route");
const post = (body: unknown) =>
  route.POST(
    new Request("http://localhost/api/drift-reasons", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

const checkInId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  env.url = "postgres://example";
  reasons.saveReason.mockReset();
});

describe("POST /api/drift-reasons", () => {
  it("passes the fields to the writer and answers the id and whether it was new, never the words", async () => {
    reasons.saveReason.mockResolvedValue({ ok: true, id: `reason|${checkInId}|req-12345678`, created: true });
    const response = await post({ checkInId, text: "a loud neighbour", requestId: "req-12345678" });
    expect(response.status).toBe(200);
    const answer = await response.json();
    expect(answer).toEqual({ id: `reason|${checkInId}|req-12345678`, created: true });
    expect(JSON.stringify(answer)).not.toContain("neighbour");
    expect(reasons.saveReason).toHaveBeenCalledWith(expect.anything(), {
      checkInId,
      text: "a loud neighbour",
      requestId: "req-12345678"
    });
  });

  it("answers the writer's refusal with its status and its sentence", async () => {
    reasons.saveReason.mockResolvedValue({ ok: false, status: 409, error: "Answer it first." });
    const response = await post({ checkInId, text: "x", requestId: "req-12345678" });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "Answer it first." });
  });

  it("hands a body that is not JSON to the writer as missing fields, which it refuses", async () => {
    reasons.saveReason.mockResolvedValue({ ok: false, status: 400, error: "bad" });
    expect((await post("not json")).status).toBe(400);
    expect(reasons.saveReason).toHaveBeenCalledWith(expect.anything(), {
      checkInId: undefined,
      text: undefined,
      requestId: undefined
    });
  });

  it("says to set DATABASE_URL when there is no database, writing nothing", async () => {
    env.url = undefined;
    const response = await post({ checkInId, text: "x", requestId: "req-12345678" });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("DATABASE_URL");
    expect(reasons.saveReason).not.toHaveBeenCalled();
  });
});
