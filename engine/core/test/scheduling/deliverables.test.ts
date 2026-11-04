import { describe, expect, it } from "vitest";
import type { DeliverableProjection } from "@openrhen/contracts";
import {
  deliverableCandidateUnits,
  deliverableForecastUnits,
  effectiveDeliverableDeadline
} from "../../src/scheduling/deliverables.js";

const now = new Date("2026-09-05T00:00:00.000Z");
const DAY_MS = 86_400_000;
const days = (count: number) => new Date(now.getTime() + count * DAY_MS).toISOString();

function projection(overrides: Partial<DeliverableProjection> = {}): DeliverableProjection {
  return {
    id: "assessment-2",
    projectId: "networking",
    title: "Assessment 2",
    status: "in_progress",
    approved: true,
    remainingMinutes: 120,
    minimumUsefulSessionMinutes: 20,
    partiallyBlocked: false,
    hasOpenBlockers: false,
    dependenciesSatisfied: true,
    incompletePrerequisites: [],
    uncertainty: "some",
    importance: 5,
    consequence: 5,
    executionOptions: [
      {
        id: "build-diagram",
        title: "Build the network diagram",
        optimisticMinutes: 30,
        expectedMinutes: 45,
        pessimisticMinutes: 60,
        remainingMinutes: 45,
        energy: "high",
        minimumSessionMinutes: 20,
        maximumSessionMinutes: 60,
        splittable: true,
        setupMinutes: 0,
        requirementPathways: []
      }
    ],
    hasSteps: true,
    ...overrides
  };
}

describe("effectiveDeliverableDeadline", () => {
  it("uses the internal date when it falls before the external one", () => {
    const p = projection({ internalDeadlineAt: days(3), externalDeadlineAt: days(10) });
    expect(effectiveDeliverableDeadline(p)?.toISOString()).toBe(days(3));
  });

  it("masks an internal date typed later than the external one, using the external date instead", () => {
    // Report-driving rule (item 1): an internal date later than the external one must never mask
    // overdue external work, so it is dropped for severity rather than allowed to win as "nearer".
    const p = projection({ internalDeadlineAt: days(10), externalDeadlineAt: days(3) });
    expect(effectiveDeliverableDeadline(p)?.toISOString()).toBe(days(3));
  });

  it("falls back to whichever single date is present", () => {
    expect(effectiveDeliverableDeadline(projection({ internalDeadlineAt: days(5) }))?.toISOString()).toBe(days(5));
    expect(effectiveDeliverableDeadline(projection({ externalDeadlineAt: days(7) }))?.toISOString()).toBe(days(7));
  });

  it("is undefined when neither date is set", () => {
    expect(effectiveDeliverableDeadline(projection())).toBeUndefined();
  });

  it("treats an internal date equal to the external one as internal", () => {
    const shared = days(4);
    const p = projection({ internalDeadlineAt: shared, externalDeadlineAt: shared });
    expect(effectiveDeliverableDeadline(p)?.getTime()).toBe(new Date(shared).getTime());
  });
});

describe("deliverable units carry the masked deadline, not the raw external one", () => {
  it("gives the forecast unit the earlier-of deadline", () => {
    const p = projection({ internalDeadlineAt: days(2), externalDeadlineAt: days(9) });
    const [unit] = deliverableForecastUnits([p]);
    expect(unit?.deadlineAt?.toISOString()).toBe(days(2));
  });

  it("gives the candidate unit the earlier-of deadline", () => {
    const p = projection({ internalDeadlineAt: days(2), externalDeadlineAt: days(9) });
    const [unit] = deliverableCandidateUnits([p]);
    expect(unit?.deadlineAt?.toISOString()).toBe(days(2));
  });

  it("never lets a later internal date suppress a passed external one on either unit", () => {
    const p = projection({ internalDeadlineAt: days(10), externalDeadlineAt: days(-1) });
    const [forecastUnit] = deliverableForecastUnits([p]);
    const [candidateUnit] = deliverableCandidateUnits([p]);
    expect(forecastUnit?.deadlineAt?.toISOString()).toBe(days(-1));
    expect(candidateUnit?.deadlineAt?.toISOString()).toBe(days(-1));
  });

  it("carries no deadline at all when the projection sets neither", () => {
    const p = projection();
    const [forecastUnit] = deliverableForecastUnits([p]);
    const [candidateUnit] = deliverableCandidateUnits([p]);
    expect(forecastUnit?.deadlineAt).toBeUndefined();
    expect(candidateUnit?.deadlineAt).toBeUndefined();
  });
});

describe("deliverable units carry their options' setup", () => {
  it("averages the execution options' setup onto both units", () => {
    const option = projection().executionOptions[0]!;
    const p = projection({
      executionOptions: [
        { ...option, id: "one", setupMinutes: 10 },
        { ...option, id: "two", setupMinutes: 20 }
      ]
    });
    expect(deliverableForecastUnits([p])[0]?.setupMinutes).toBe(15);
    expect(deliverableCandidateUnits([p])[0]?.setupMinutes).toBe(15);
  });

  it("stays zero when no option states any setup", () => {
    expect(deliverableForecastUnits([projection()])[0]?.setupMinutes).toBe(0);
  });
});
