import { describe, expect, it } from "vitest";
import { CORE_FLOW_ENTRIES } from "./data-flow.js";
import { flowEntrySchema, formatDatasetRef, parseDatasetRef, datasetNoteSchema } from "./types.js";
import { parseSurface, surfaceHasValue, surfacePageFile } from "./surfaces.js";

describe("flow entry schema", () => {
  it("accepts every core entry", () => {
    for (const entry of CORE_FLOW_ENTRIES) expect(flowEntrySchema.safeParse(entry).success, entry.id).toBe(true);
  });

  it("refuses an unknown field, a bad dataset name and a probe without its fields", () => {
    const base = CORE_FLOW_ENTRIES[0]!;
    expect(flowEntrySchema.safeParse({ ...base, status: "in-progress" }).success).toBe(false);
    expect(flowEntrySchema.safeParse({ ...base, to: ["table:x"] }).success).toBe(false);
    expect(flowEntrySchema.safeParse({ ...base, health: { kind: "max", table: "x" } }).success).toBe(false);
    expect(flowEntrySchema.safeParse({ ...base, health: { kind: "lag", upstream: { kind: "none" } } }).success).toBe(
      false
    );
  });

  it("parses a lag probe whose sides are probes", () => {
    const none = { kind: "none", reason: "r" } as const;
    const probe = { kind: "lag", upstream: none, downstream: none, allowHours: 2 };
    expect(flowEntrySchema.safeParse({ ...CORE_FLOW_ENTRIES[0]!, health: probe }).success).toBe(true);
  });

  it("checks dataset notes", () => {
    expect(datasetNoteSchema.safeParse({ ref: "pg:x", dead: "why" }).success).toBe(true);
    expect(datasetNoteSchema.safeParse({ ref: "x" }).success).toBe(false);
  });
});

describe("dataset names and surfaces", () => {
  it("round-trips a partition", () => {
    const ref = "pg:activity_events[source=a,kind=b]";
    expect(formatDatasetRef(parseDatasetRef(ref)!)).toBe(ref);
  });

  it("knows the surface kinds, their names and which carry value", () => {
    expect(parseSurface("surface:page/review/day")).toEqual({ kind: "page", name: "review/day" });
    expect(parseSurface("surface:engine")).toEqual({ kind: "engine" });
    expect(parseSurface("surface:page")).toBeNull();
    expect(parseSurface("surface:engine/x")).toBeNull();
    expect(parseSurface("surface:nowhere/x")).toBeNull();
    expect(surfaceHasValue("surface:rest")).toBe(false);
    expect(surfaceHasValue("surface:backup")).toBe(false);
    expect(surfaceHasValue("surface:push")).toBe(true);
    expect(surfacePageFile("surface:page/review")).toBe("portal/app/review/page.tsx");
    expect(surfacePageFile("surface:engine")).toBeNull();
  });
});
