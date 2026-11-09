import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ url: "postgres://example" as string | undefined }));
const tags = vi.hoisted(() => ({ setReasonTags: vi.fn() }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => env.url }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
vi.mock("@/server/drift/reason-tags", () => tags);

const route = await import("./route");
const checkInId = "11111111-1111-4111-8111-111111111111";
const put = (body: unknown, id = checkInId) =>
  route.PUT(
    new Request(`http://localhost/api/drift-reasons/${id}/tags`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    { params: Promise.resolve({ checkInId: id }) }
  );

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  env.url = "postgres://example";
  tags.setReasonTags.mockReset();
});

describe("PUT /api/drift-reasons/[checkInId]/tags", () => {
  it("passes the fields to the writer and answers the reason as it now reads, uncached", async () => {
    const reason = {
      checkInId,
      text: "words",
      savedAt: "2026-11-09T10:00:00.000Z",
      tags: ["mine"],
      origin: "corrected",
      stale: false
    };
    tags.setReasonTags.mockResolvedValue({ ok: true, reason });
    const response = await put({ tags: ["mine"], requestId: "req-12345678" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(reason);
    expect(tags.setReasonTags).toHaveBeenCalledWith(expect.anything(), {
      checkInId,
      tags: ["mine"],
      reset: undefined,
      requestId: "req-12345678"
    });
  });

  it("passes a reset through", async () => {
    tags.setReasonTags.mockResolvedValue({ ok: false, status: 404, error: "gone" });
    await put({ reset: true, requestId: "req-12345678" });
    expect(tags.setReasonTags).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reset: true }));
  });

  it("answers the writer's refusal with its status and sentence", async () => {
    tags.setReasonTags.mockResolvedValue({ ok: false, status: 400, error: "Too many tags." });
    const response = await put({ tags: [], requestId: "req-12345678" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Too many tags." });
  });

  it("hands a body that is not JSON to the writer as missing fields, which it refuses", async () => {
    tags.setReasonTags.mockResolvedValue({ ok: false, status: 400, error: "bad" });
    expect((await put("not json")).status).toBe(400);
    expect(tags.setReasonTags).toHaveBeenCalledWith(expect.anything(), {
      checkInId,
      tags: undefined,
      reset: undefined,
      requestId: undefined
    });
  });

  it("says to set DATABASE_URL when there is no database, writing nothing", async () => {
    env.url = undefined;
    expect((await put({ tags: [], requestId: "req-12345678" })).status).toBe(503);
    expect(tags.setReasonTags).not.toHaveBeenCalled();
  });

  it("rethrows only the error's kind, so a message quoting a row never reaches the log", async () => {
    tags.setReasonTags.mockRejectedValue(new Error("duplicate key (zebra kettle words)"));
    const logged: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void logged.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args.join(" ")));
    await put({ tags: ["a"], requestId: "req-12345678" }).catch(() => undefined);
    expect(logged.join("\n")).not.toContain("zebra");
  });
});
