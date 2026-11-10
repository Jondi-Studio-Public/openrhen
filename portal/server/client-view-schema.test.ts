import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIENT_VIEW_TYPES, clientViewFixtures, clientViewJsonSchema } from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../platform/contracts/${name}`, import.meta.url)), "utf8"));

describe("the published client view JSON Schema and fixtures", () => {
  it("are the files in platform/contracts, so the app's decoders and the server check the same thing", () => {
    expect(read("client-view-schema.v1.json")).toEqual(JSON.parse(JSON.stringify(clientViewJsonSchema())));
    expect(read("client-view-fixtures.v1.json")).toEqual(JSON.parse(JSON.stringify(clientViewFixtures())));
  });

  it("have one schema entry and at least one fixture for every exported type", () => {
    const schema = clientViewJsonSchema() as { $defs: Record<string, unknown> };
    expect(Object.keys(schema.$defs).sort()).toEqual(Object.keys(CLIENT_VIEW_TYPES).sort());
    for (const [name, examples] of Object.entries(clientViewFixtures()))
      expect(examples.length, name).toBeGreaterThan(0);
  });

  it("parse every fixture with its own schema, so an example cannot drift from the type", () => {
    for (const [name, examples] of Object.entries(clientViewFixtures()))
      for (const example of examples)
        expect(CLIENT_VIEW_TYPES[name as keyof typeof CLIENT_VIEW_TYPES].safeParse(example).success, name).toBe(true);
  });

  it("refuse a time without an offset, which the wire never carries", () => {
    const [full] = clientViewFixtures().ClientView as { day: { startsAt: string }[] }[];
    const bad = { ...full, day: [{ ...full!.day[0], startsAt: "2026-11-10T09:00:00" }] };
    expect(CLIENT_VIEW_TYPES.ClientView.safeParse(bad).success).toBe(false);
  });
});
