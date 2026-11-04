import { describe, expect, it } from "vitest";
import { AGENT_SESSION_MAX_TOUCHED } from "@openrhen/contracts";
import { bumpTouched } from "./agent-session-store";

describe("bumpTouched", () => {
  it("counts each route template and keeps the others", () => {
    let touched: Record<string, number> = {};
    for (const route of ["/api/state", "/api/state", "/api/changes"]) touched = bumpTouched(touched, route);
    expect(touched).toEqual({ "/api/state": 2, "/api/changes": 1 });
  });

  it("folds new templates into other once the cap is reached, but still counts known ones", () => {
    let touched: Record<string, number> = {};
    for (let i = 0; i < AGENT_SESSION_MAX_TOUCHED; i += 1) touched = bumpTouched(touched, `/api/r${i}`);
    touched = bumpTouched(touched, "/api/new");
    touched = bumpTouched(touched, "/api/new");
    touched = bumpTouched(touched, "/api/r0");
    expect(touched.other).toBe(2);
    expect(touched["/api/r0"]).toBe(2);
    expect(touched["/api/new"]).toBeUndefined();
  });

  it("does not change its input", () => {
    const touched = { "/api/state": 1 };
    bumpTouched(touched, "/api/state");
    expect(touched).toEqual({ "/api/state": 1 });
  });
});
