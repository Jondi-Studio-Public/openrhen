import { describe, expect, it } from "vitest";
import { conditionDefinitionSchema } from "@openrhen/contracts";
import { routesFromRequires } from "./requires-write";

const defs = [conditionDefinitionSchema.parse({ id: "garage", name: "Garage", kind: "location" })];
const subject = { id: "a1", title: "Fit frame", tool: "action" as const };

describe("routesFromRequires", () => {
  it("requires: [] clears an action that has two alternative routes", () => {
    expect(routesFromRequires([], defs as never, [["garage"], ["street"]], subject)).toEqual([]);
  });

  it("a non-empty list still refuses to flatten two routes", () => {
    expect(() => routesFromRequires(["garage"], defs as never, [["garage"], ["street"]], subject)).toThrow(
      /2 alternative routes/
    );
  });
});
