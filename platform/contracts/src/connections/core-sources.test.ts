import { describe, expect, it } from "vitest";
import { ACTIVITY_SOURCES } from "../activity-events.js";
import { CORE_SOURCES } from "./core-sources.js";
import { isRegisteredConnection } from "./registry.js";

describe("CORE_SOURCES", () => {
  it("names only sources that exist: an activity source or a registered connection", () => {
    for (const name of CORE_SOURCES)
      expect(Object.hasOwn(ACTIVITY_SOURCES, name) || isRegisteredConnection(name), name).toBe(true);
  });

  it("has no duplicates", () => {
    expect(new Set(CORE_SOURCES).size).toBe(CORE_SOURCES.length);
  });
});
