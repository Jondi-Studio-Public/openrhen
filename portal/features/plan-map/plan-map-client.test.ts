import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bulkConfirmPlanLinks,
  createPlanLink,
  decidePlanFinding,
  decidePlanLink,
  fetchPlanMap,
  setPlanMapSwitch
} from "./plan-map-client";
import { link, planMap } from "./test-fixtures";

const reply = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) } as Response);

afterEach(() => vi.unstubAllGlobals());

describe("plan map client", () => {
  it("reads the map", async () => {
    const fetchMock = reply(planMap());
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchPlanMap()).subjects).toHaveLength(2);
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/plan-map");
  });

  it("posts a link and returns the stored one", async () => {
    const stored = link();
    const fetchMock = reply({ link: stored });
    vi.stubGlobal("fetch", fetchMock);
    const input = { fromType: "action", fromId: "a1", toType: "subject", toId: "maths", kind: "about" } as const;
    expect(await createPlanLink(input)).toEqual(stored);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/plan-map/links");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify(input) });
  });

  it("sends each action to its route", async () => {
    const fetchMock = reply({ confirmed: 3, ids: ["l1", "l2", "l3"] });
    vi.stubGlobal("fetch", fetchMock);
    await decidePlanLink("l 1", "reject");
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/plan-map/links/l%201");
    expect(fetchMock.mock.calls[0]![1].body).toBe('{"action":"reject"}');
    expect(await bulkConfirmPlanLinks("rule:x", "about")).toEqual(["l1", "l2", "l3"]);
    expect(fetchMock.mock.calls[1]![0]).toBe("/api/plan-map/links/bulk");
    await decidePlanFinding("f1", "dismiss");
    expect(fetchMock.mock.calls[2]![0]).toBe("/api/plan-map/findings/f1");
    await decidePlanLink("l1", "reopen");
    expect(fetchMock.mock.calls[3]![1].body).toBe('{"action":"reopen"}');
    await decidePlanFinding("f1", "reopen");
    expect(fetchMock.mock.calls[4]![1].body).toBe('{"action":"reopen"}');
    await setPlanMapSwitch("nudge", "shadow");
    expect(fetchMock.mock.calls[5]![1]).toMatchObject({ method: "PUT", body: '{"addon":"nudge","mode":"shadow"}' });
  });

  it("throws the route's error, or a fallback when it gave none", async () => {
    vi.stubGlobal("fetch", reply({ error: "An item cannot link to itself." }, false));
    await expect(decidePlanLink("l1", "confirm")).rejects.toThrow("An item cannot link to itself.");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: () => Promise.reject(new Error("no body")) }));
    await expect(fetchPlanMap()).rejects.toThrow("The plan map could not be loaded.");
  });
});
