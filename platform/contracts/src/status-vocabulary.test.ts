import { describe, expect, it } from "vitest";
import { actionStatusSchema, lifecycleStatusSchema } from "./core.js";
import { conditionStatusSchema } from "./planning/context-model.js";
import {
  captureStatusSchema,
  commitmentStatusSchema,
  deliverableStatusSchema,
  routinePresetStatusSchema,
  routineStepStatusSchema,
  sleepPlanStatusSchema
} from "./portal/state-schema.js";
import { STATUS_VOCABULARY, normalizeStatus } from "./status-vocabulary.js";

const SOURCES: Record<string, readonly string[]> = {
  area: lifecycleStatusSchema.options,
  outcome: lifecycleStatusSchema.options,
  project: lifecycleStatusSchema.options,
  action: actionStatusSchema.options,
  commitment: commitmentStatusSchema.options,
  capture: captureStatusSchema.options,
  deliverable: deliverableStatusSchema.options,
  routine_step: routineStepStatusSchema.options,
  routine_preset: routinePresetStatusSchema.options,
  sleep_plan: sleepPlanStatusSchema.options,
  condition_definition: conditionStatusSchema.options
};

describe("STATUS_VOCABULARY", () => {
  it("covers exactly the kinds with a source enum, with values equal to its options", () => {
    expect(Object.keys(STATUS_VOCABULARY).sort()).toEqual(Object.keys(SOURCES).sort());
    for (const [kind, options] of Object.entries(SOURCES)) {
      expect(STATUS_VOCABULARY[kind]?.values, kind).toEqual(options);
    }
  });

  it("maps every synonym onto a valid value for its kind", () => {
    for (const [kind, entry] of Object.entries(STATUS_VOCABULARY)) {
      for (const [word, target] of Object.entries(entry.synonyms)) {
        expect(entry.values, `${kind}: ${word}`).toContain(target);
      }
    }
  });

  it("never uses a valid value as a synonym key", () => {
    for (const [kind, entry] of Object.entries(STATUS_VOCABULARY)) {
      for (const word of Object.keys(entry.synonyms)) {
        expect(entry.values, `${kind}: ${word}`).not.toContain(word);
      }
    }
  });
});

describe("normalizeStatus", () => {
  it("accepts a valid value as is, trimmed and lower-cased", () => {
    expect(normalizeStatus("routine_step", "completed")).toEqual({ ok: true, status: "completed" });
    expect(normalizeStatus("routine_step", "  Skipped ")).toEqual({ ok: true, status: "skipped" });
  });

  it("maps a synonym and reports the word it replaced", () => {
    expect(normalizeStatus("routine_step", "done")).toEqual({ ok: true, status: "completed", from: "done" });
    expect(normalizeStatus("action", "Finished")).toEqual({ ok: true, status: "done", from: "finished" });
    expect(normalizeStatus("project", "canceled")).toEqual({ ok: true, status: "cancelled", from: "canceled" });
    expect(normalizeStatus("action", "to do")).toEqual({ ok: true, status: "planned", from: "to do" });
    expect(normalizeStatus("project", "on-hold")).toEqual({ ok: true, status: "paused", from: "on-hold" });
  });

  it("treats a hyphen or space as an underscore", () => {
    expect(normalizeStatus("deliverable", "in-progress")).toEqual({ ok: true, status: "in_progress" });
    expect(normalizeStatus("deliverable", "Needs Breakdown")).toEqual({ ok: true, status: "needs_breakdown" });
    expect(normalizeStatus("routine_step", "in progress")).toEqual({ ok: true, status: "doing", from: "in progress" });
  });

  it("does not turn one valid value into another", () => {
    expect(normalizeStatus("routine_step", "skipped")).toEqual({ ok: true, status: "skipped" });
    expect(normalizeStatus("action", "active")).toEqual({ ok: true, status: "active" });
  });

  it("fails with the allowed list for an unknown word or kind", () => {
    expect(normalizeStatus("sleep_plan", "napping")).toEqual({ ok: false, allowed: sleepPlanStatusSchema.options });
    expect(normalizeStatus("routine_preset", "done")).toEqual({ ok: false, allowed: ["active", "archived"] });
    expect(normalizeStatus("settings", "active")).toEqual({ ok: false, allowed: [] });
    expect(normalizeStatus("action", "constructor")).toEqual({ ok: false, allowed: actionStatusSchema.options });
  });
});
