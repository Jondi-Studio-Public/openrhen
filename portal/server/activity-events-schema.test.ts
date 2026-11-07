import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { activityEventsJsonSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

describe("the published activity-events JSON Schema", () => {
  const file = fileURLToPath(new URL("../../platform/contracts/activity-events-schema.v1.json", import.meta.url));

  it("is the file in platform/contracts, so client authors and the portal validate the same thing", () => {
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(JSON.parse(JSON.stringify(activityEventsJsonSchema())));
  });

  it("pins the request shape: schema 1, events with an id, source, kind and start, and the source registry", () => {
    const schema = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
    expect(schema.$id).toBe("https://openrhen.example/schemas/activity-events.v1.json");
    expect(schema.properties.schema.const).toBe(1);
    expect(schema.properties.events.maxItems).toBe(1000);
    expect(schema.properties.events.items.required).toEqual(["id", "source", "kind", "start"]);
    expect(schema.required).toEqual(["schema", "events"]);
    expect(Object.keys(schema["x-sources"])).toContain("iphone-health");
  });
});
