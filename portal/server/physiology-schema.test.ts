import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PHYSIOLOGY_DAILY_FIELDS,
  PHYSIOLOGY_HRV_METHODS,
  PHYSIOLOGY_KINDS,
  PHYSIOLOGY_MOVEMENT_STATES,
  PHYSIOLOGY_SLEEP_STAGES,
  physiologyJsonSchema
} from "@openrhen/contracts";
import { describe, expect, it } from "vitest";

describe("the published physiology JSON Schema", () => {
  const file = fileURLToPath(new URL("../../platform/contracts/physiology-schema.v1.json", import.meta.url));
  const schema = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;

  it("is the file in platform/contracts, so collector authors and the portal validate the same thing", () => {
    expect(schema()).toEqual(JSON.parse(JSON.stringify(physiologyJsonSchema())));
  });

  it("pins the event shape: source physiology, the kinds, and the key form", () => {
    const published = schema();
    expect(published.$id).toBe("https://openrhen.example/schemas/physiology.v1.json");
    expect(published.required).toEqual(["id", "source", "kind", "start", "attrs"]);
    expect(published.properties.source.const).toBe("physiology");
    expect(published.properties.kind.enum).toEqual([...PHYSIOLOGY_KINDS, "correction"]);
    expect(published["x-key"].form).toBe("<kind>|<attrs.device>|<period>|v<attrs.v>");
    expect(published["x-schemaVersion"]).toBe(1);
  });

  it("pins every kind's required attrs and its closed lists", () => {
    const attrs = schema().$defs.attrs as Record<string, any>;
    expect(Object.keys(attrs).sort()).toEqual([...PHYSIOLOGY_KINDS, "correction"].sort());
    for (const kind of PHYSIOLOGY_KINDS) {
      expect(attrs[kind].required.slice(0, 3), kind).toEqual(["device", "route", "v"]);
      expect(attrs[kind].additionalProperties, kind).toBe(false);
    }
    expect(attrs.heart_rate.properties.unit.enum).toEqual(["bpm"]);
    expect(attrs.heart_rate.properties.step_s.minimum).toBe(15);
    expect(attrs.heart_rate_dense.properties.step_s).toMatchObject({ minimum: 1, maximum: 14 });
    expect(attrs.hrv.properties.method.enum).toEqual([...PHYSIOLOGY_HRV_METHODS]);
    expect(attrs.skin_temp.properties.unit.enum).toEqual(["degC", "degC_delta"]);
    expect(attrs.movement.properties.segments.items.properties.state.enum).toEqual([...PHYSIOLOGY_MOVEMENT_STATES]);
    expect(attrs.sleep.properties.segments.items.properties.stage.enum).toEqual([...PHYSIOLOGY_SLEEP_STAGES]);
    expect(Object.keys(attrs.daily.properties)).toEqual(
      expect.arrayContaining([...PHYSIOLOGY_DAILY_FIELDS, "local_date", "device", "route", "v"])
    );
    expect(attrs.score.required).toEqual(["device", "route", "v", "score_name", "scale", "value"]);
    expect(attrs.stress.required).toContain("scale");
    expect(attrs.score_series.required).toEqual(expect.arrayContaining(["score_name", "scale"]));
    expect(attrs.heart_rate.properties.device).toMatchObject({ minLength: 1, maxLength: 64 });
    expect(attrs.heart_rate.properties.route).toMatchObject({ minLength: 1, maxLength: 32 });
    expect(attrs.heart_rate.properties.v).toMatchObject({ minimum: 0, maximum: 999 });
    expect(attrs.heart_rate.properties.values.maxItems).toBe(300);
    expect(attrs.heart_rate.properties.t.maxItems).toBe(240);
  });

  it("names no vendor in the schema, the validator module or the collector guide", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const legacy = /\b(?:apple|iphone)-health\b/g;
    const texts = [
      file,
      `${root}platform/contracts/src/activity-physiology.ts`,
      `${root}docs/operations/posting-physiology-data.md`
    ].map((path) => ({ path, text: readFileSync(path, "utf8").replace(legacy, "") }));
    const vendors = [
      "apple",
      "garmin",
      "fitbit",
      "whoop",
      "oura",
      "polar",
      "samsung",
      "google",
      "huawei",
      "amazfit",
      "coros",
      "withings",
      "suunto",
      "xiaomi",
      "strava"
    ];
    const pattern = new RegExp(`\\b(?:${vendors.join("|")})\\b`, "i");
    for (const { path, text } of texts) expect(text, path).not.toMatch(pattern);
    // Word boundaries: a longer word that merely contains a vendor name is not a hit.
    expect(pattern.test("a bipolar disorder, a courage")).toBe(false);
    expect(pattern.test("an Oura ring")).toBe(true);
  });
});
