import { describe, expect, it } from "vitest";
import type { PortalState } from "../src/client.js";
import { resolveReference } from "../src/resolve.js";
import { fixtureRawState } from "./fixture-state.js";

/** The raw fixture already has the `state` shape `resolveReference` reads; no normalisation needed. */
function state(): PortalState {
  return fixtureRawState() as unknown as PortalState;
}

describe("resolveReference", () => {
  it("matches a context definition by its name, since places carry a name rather than a title", () => {
    expect(resolveReference(state(), "conditions", "gym").id).toBe("ctx-gym");
    expect(resolveReference(state(), "conditions", "Home").id).toBe("ctx-home");
  });

  it("still matches a context definition by id", () => {
    expect(resolveReference(state(), "conditions", "ctx-laptop").name).toBe("Laptop");
  });

  it("reports an unknown place as not found", () => {
    expect(() => resolveReference(state(), "conditions", "Moon")).toThrow(/No condition with id or name "Moon"/);
  });
});
