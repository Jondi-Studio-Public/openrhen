import { describe, expect, it } from "vitest";
import { PLACEHOLDER_TOKEN, startupRefusal } from "./startup.js";

describe("engine service startup", () => {
  it("requires a token", () => expect(startupRefusal({})).toMatch(/required/));
  it("accepts the placeholder unless owner auth is require", () => {
    for (const mode of [undefined, "off", "shadow"])
      expect(
        startupRefusal({ PLAN_FORECAST_SERVICE_TOKEN: PLACEHOLDER_TOKEN, OPENRHEN_OWNER_AUTH: mode })
      ).toBeUndefined();
  });
  it("refuses the placeholder under require", () => {
    expect(
      startupRefusal({ PLAN_FORECAST_SERVICE_TOKEN: PLACEHOLDER_TOKEN, OPENRHEN_OWNER_AUTH: " Require " })
    ).toMatch(/placeholder/);
  });
  it("accepts a real token under require", () =>
    expect(startupRefusal({ PLAN_FORECAST_SERVICE_TOKEN: "real", OPENRHEN_OWNER_AUTH: "require" })).toBeUndefined());
});
