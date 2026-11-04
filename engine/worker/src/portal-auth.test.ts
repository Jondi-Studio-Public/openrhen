import { WORKER_HEADER as CONTRACT_HEADER } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";
import { WORKER_HEADER, portalHeaders } from "./portal-auth.js";

describe("portalHeaders", () => {
  it("names the header the portal reads", () => expect(WORKER_HEADER).toBe(CONTRACT_HEADER));

  it("adds the worker token when one is set", () => {
    expect(portalHeaders({ "content-type": "application/json" }, { OPENRHEN_WORKER_TOKEN: " tok " })).toEqual({
      "content-type": "application/json",
      [WORKER_HEADER]: "tok"
    });
  });

  it("sends nothing extra when none is set", () => {
    expect(portalHeaders({ "content-type": "application/json" }, {})).toEqual({ "content-type": "application/json" });
    expect(portalHeaders({}, { OPENRHEN_WORKER_TOKEN: "  " })).toEqual({});
  });
});
