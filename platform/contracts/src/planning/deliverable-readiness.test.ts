import { describe, expect, it } from "vitest";
import { assessDeliverable, type ReadinessDeliverable, type ReadinessStep } from "./deliverable-readiness.js";
import { conditionDefinitionSchema, currentSituationSchema } from "./context-model.js";

const NOW = new Date("2026-11-02T03:00:00Z");
const definitions = [
  conditionDefinitionSchema.parse({ id: "pete", name: "Pete", kind: "contact", channels: ["sync_remote"] })
];
const step = (keys: string[]): ReadinessStep => ({
  id: "s1",
  title: "Fit the frame",
  status: "planned",
  optimisticMinutes: 30,
  expectedMinutes: 60,
  pessimisticMinutes: 90,
  remainingMinutes: 60,
  energy: "medium",
  minimumSessionMinutes: 15,
  maximumSessionMinutes: 60,
  splittable: true,
  setupMinutes: 0,
  required: true,
  dependencyIds: [],
  requirementPathways: keys.length ? [{ id: "r1", contextIds: keys }] : []
});
const deliverable = (keys: string[]): ReadinessDeliverable => ({
  id: "d1",
  projectId: "p1",
  title: "Hive",
  status: "active",
  contractVersion: 1,
  planVersion: 1,
  uncertainty: "known",
  importance: 3,
  consequence: 3,
  dependencyIds: [],
  steps: [step(keys)],
  criteria: [],
  blockers: []
});
const assess = (keys: string[], situation: Record<string, unknown> = {}, timeZone?: string) =>
  assessDeliverable({
    deliverable: deliverable(keys),
    situation: currentSituationSchema.parse(situation),
    conditionDefinitions: definitions,
    now: NOW,
    ...(timeZone ? { timeZone } : {})
  }).steps[0]!;

describe("a deliverable step that needs a person", () => {
  it("is held by the situation without presence", () => {
    const readiness = assess(["pete@with"]);
    expect(readiness.executable).toBe(false);
    expect(readiness.reason).toBe("situation");
    expect(readiness.conditionMatch.personHold?.people[0]).toMatchObject({ contactId: "pete", state: "unknown" });
  });

  it("is executable while the person is here, and held again after the owner's local midnight", () => {
    const here = {
      presence: { pete: { state: "here", setAt: "2026-11-02T01:00:00Z", until: "2026-11-02T13:00:00Z" } }
    };
    // Auckland (UTC+13 in November): 03:00Z is 16:00 local, so local midnight is 11:00Z.
    expect(assess(["pete@with"], here, "Pacific/Auckland").executable).toBe(true);
    const later = assessDeliverable({
      deliverable: deliverable(["pete@with"]),
      situation: currentSituationSchema.parse(here),
      conditionDefinitions: definitions,
      now: new Date("2026-11-02T14:00:00Z"),
      timeZone: "Pacific/Auckland"
    }).steps[0]!;
    expect(later.executable).toBe(false);
  });

  it("treats a bare contact exactly as before", () => {
    expect(assess(["pete"]).executable).toBe(true);
  });
});
