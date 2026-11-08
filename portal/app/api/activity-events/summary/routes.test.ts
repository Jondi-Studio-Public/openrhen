import { beforeEach, describe, expect, it, vi } from "vitest";

/** The summary route's framing: the plain summary by default, the eval report only when asked for by name. */
vi.mock("@/server/runtime-env", () => ({ databaseUrl: () => "postgres://test" }));
vi.mock("@/server/persistence/postgres/sql-pool", () => ({ sqlPool: () => ({}) }));
const store = vi.hoisted(() => ({ readActivitySummary: vi.fn(), readEvalReport: vi.fn() }));
vi.mock("@/server/persistence/postgres/eval-report-store", async (importActual) => ({
  ...(await importActual<typeof import("@/server/persistence/postgres/eval-report-store")>()),
  readEvalReport: store.readEvalReport
}));
vi.mock("@/server/persistence/postgres/activity-store", () => ({ readActivitySummary: store.readActivitySummary }));

const route = await import("./route");
const get = (query = "") => route.GET(new Request(`http://localhost/api/activity-events/summary${query}`), undefined);

beforeEach(() => {
  store.readActivitySummary
    .mockReset()
    .mockResolvedValue({ sources: [], extractors: [], imports: [], derivedBehind: 0 });
  store.readEvalReport.mockReset().mockResolvedValue({ labels: { total: 0, unfielded: 0, ignored: 0 }, versions: [] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/activity-events/summary", () => {
  it("returns the summary alone by default, without computing the eval report", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sources: [], extractors: [], imports: [], derivedBehind: 0 });
    expect(store.readEvalReport).not.toHaveBeenCalled();
  });

  it("adds the eval report under `eval` for report=eval", async () => {
    const response = await get("?report=eval");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ derivedBehind: 0, eval: { labels: { total: 0 }, versions: [] } });
    expect(store.readEvalReport).toHaveBeenCalledOnce();
  });

  it("passes tokens and seconds per message to the report as a backfill sizing request", async () => {
    const response = await get("?report=eval&tokens_per_message=800&seconds_per_message=1.5");
    expect(response.status).toBe(200);
    expect(store.readEvalReport).toHaveBeenCalledWith(expect.anything(), {
      backfill: { tokensPerMessage: 800, secondsPerMessage: 1.5 },
      window: undefined
    });
  });

  it("asks for no sizing when neither parameter is given", async () => {
    await get("?report=eval");
    expect(store.readEvalReport).toHaveBeenCalledWith(expect.anything(), { backfill: undefined, window: undefined });
  });

  it("refuses one sizing parameter without the other, and a value outside the bounds, saying the fix", async () => {
    const one = await get("?report=eval&tokens_per_message=800");
    expect(one.status).toBe(400);
    expect(((await one.json()) as { error: string }).error).toContain("seconds_per_message");
    const huge = await get("?report=eval&tokens_per_message=99999999&seconds_per_message=1");
    expect(huge.status).toBe(400);
    expect(((await huge.json()) as { error: string }).error).toMatch(/tokensPerMessage.*at most 1000000/);
    const text = await get("?report=eval&tokens_per_message=lots&seconds_per_message=1");
    expect(text.status).toBe(400);
    expect(((await text.json()) as { error: string }).error).toContain("tokens_per_message");
    expect(store.readEvalReport).not.toHaveBeenCalled();
  });

  it("refuses the sizing parameters without report=eval, rather than ignoring them", async () => {
    const response = await get("?tokens_per_message=800&seconds_per_message=1");
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("report=eval");
  });

  it("passes a window to the report, and refuses one outside its bounds with the limits", async () => {
    await get("?report=eval&window=5000");
    expect(store.readEvalReport).toHaveBeenCalledWith(expect.anything(), { backfill: undefined, window: 5000 });
    for (const bad of ["50", "5000000", "lots", "1.5"]) {
      store.readEvalReport.mockClear();
      const response = await get(`?report=eval&window=${bad}`);
      expect(response.status, bad).toBe(400);
      const { error } = (await response.json()) as { error: string };
      expect(error, bad).toContain("window");
      expect(error, bad).toContain("100 to 1000000");
      expect(store.readEvalReport).not.toHaveBeenCalled();
    }
    expect((await get("?window=5000")).status).toBe(400);
  });

  it("answers a statement timeout (Postgres 57014) with a 503 an agent can act on, not an opaque 500", async () => {
    store.readEvalReport.mockRejectedValue(
      Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
    );
    const response = await get("?report=eval");
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain("timed out");
    expect(error).toContain("heavy");
    expect(error).toContain("window=");
    expect(error).toContain("Retry in a minute");
    expect(error).toContain("15s");
  });

  it("lets any other failure through as the ordinary error", async () => {
    store.readEvalReport.mockRejectedValue(new Error("connection reset"));
    const response = await get("?report=eval");
    expect(response.status).toBe(500);
  });

  it("refuses another report name with the allowed value and the fix", async () => {
    const response = await get("?report=everything");
    expect(response.status).toBe(400);
    const { error } = (await response.json()) as { error: string };
    expect(error).toContain('"everything"');
    expect(error).toContain("eval");
    expect(error).toContain("Remove the report parameter");
    expect(store.readActivitySummary).not.toHaveBeenCalled();
  });
});
