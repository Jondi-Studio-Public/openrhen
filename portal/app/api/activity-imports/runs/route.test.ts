import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/agent-activity", () => ({ noteAgentCall: () => {} }));
vi.mock("@/server/runtime-env", () => ({ databaseUrl: vi.fn(() => "postgres://test") }));
const log = vi.hoisted(() => ({ recordRun: vi.fn(async () => undefined) }));
vi.mock("@/server/persistence/postgres/run-log", () => log);

const env = await import("@/server/runtime-env");
const route = await import("./route");

const valid = {
  source: "timeline",
  status: "synced",
  startedAt: "2026-11-09T01:00:00Z",
  finishedAt: "2026-11-09T01:00:05Z",
  summary: { file: "Records.json", events: 10, skipped: 0, rejected: 0, truncated: 0, warnings: [] }
};

const post = (body: unknown) =>
  route.POST(
    new Request("http://localhost/api/activity-imports/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body)
    }),
    undefined
  );

beforeEach(() => {
  log.recordRun.mockClear();
  vi.mocked(env.databaseUrl).mockReturnValue("postgres://test");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/activity-imports/runs", () => {
  it("writes an import:<source> row with trigger manual", async () => {
    const response = await post(valid);
    expect(response.status).toBe(200);
    expect(log.recordRun).toHaveBeenCalledOnce();
    expect(log.recordRun).toHaveBeenCalledWith({
      provider: "import:timeline",
      trigger: "manual",
      status: "synced",
      startedAt: new Date("2026-11-09T01:00:00Z"),
      finishedAt: new Date("2026-11-09T01:00:05Z"),
      summary: valid.summary
    });
  });

  it("accepts youtube-watch-history, which is not an activity source", async () => {
    expect((await post({ ...valid, source: "youtube-watch-history" })).status).toBe(200);
    expect(log.recordRun).toHaveBeenCalledWith(expect.objectContaining({ provider: "import:youtube-watch-history" }));
  });

  it("returns 400 for an unknown source and lists the valid ones", async () => {
    const response = await post({ ...valid, source: "nope" });
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("timeline");
    expect(error).toContain("youtube-watch-history");
    expect(log.recordRun).not.toHaveBeenCalled();
  });

  it.each([
    ["a status outside the three", { ...valid, status: "not_configured" }],
    ["a start that is not RFC 3339", { ...valid, startedAt: "yesterday" }],
    ["more than 20 warnings", { ...valid, summary: { ...valid.summary, warnings: Array(21).fill("w") } }],
    ["a warning over 200 characters", { ...valid, summary: { ...valid.summary, warnings: ["x".repeat(201)] } }],
    ["a file name over 300 characters", { ...valid, summary: { ...valid.summary, file: "f".repeat(301) } }],
    ["an error over 500 characters", { ...valid, summary: { ...valid.summary, error: "e".repeat(501) } }],
    ["a negative count", { ...valid, summary: { ...valid.summary, events: -1 } }],
    [
      "a missing summary",
      { source: "timeline", status: "synced", startedAt: valid.startedAt, finishedAt: valid.finishedAt }
    ],
    ["a body that is not JSON", "not json"]
  ])("returns 400 for %s", async (_name, body) => {
    expect((await post(body)).status).toBe(400);
    expect(log.recordRun).not.toHaveBeenCalled();
  });

  it("returns 503 without a database", async () => {
    vi.mocked(env.databaseUrl).mockReturnValue(undefined as never);
    expect((await post(valid)).status).toBe(503);
    expect(log.recordRun).not.toHaveBeenCalled();
  });

  it("keeps only a base name for the file", async () => {
    await post({ ...valid, summary: { ...valid.summary, file: "C:\\Users\\someone\\Takeout\\Records.json" } });
    expect(log.recordRun).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.objectContaining({ file: "Records.json" }) })
    );
  });
});
