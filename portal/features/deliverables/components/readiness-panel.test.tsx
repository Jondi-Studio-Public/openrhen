// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { ReadinessPanel, plannerOpinionText } from "./readiness-panel";
import { assess, criterion, deliverable, step } from "@/features/deliverables/test-fixtures";

describe("ReadinessPanel", () => {
  it("names each coverage failure that blocks approval", () => {
    const plan = deliverable({
      contractApprovedAt: undefined,
      planApprovedAt: undefined,
      steps: [step("orphan", { title: "Orphan step" })],
      criteria: [criterion("bare", { title: "Bare criterion" })]
    });
    render(<ReadinessPanel deliverable={plan} readiness={assess(plan)} engine={undefined} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Required criterion “Bare criterion” has no action that makes it true.");
    expect(alert.textContent).toContain("Required action “Orphan step” contributes to no criterion.");
    expect(screen.getByText("Not looked at by the planner yet.")).toBeTruthy();
  });

  it("reports remaining effort, workable steps and the planner's opinion", () => {
    const plan = deliverable({
      steps: [step("a", { remainingMinutes: 20 }), step("b", { remainingMinutes: 40, dependencyIds: ["a"] })],
      criteria: [criterion("c", { stepIds: ["a", "b"] })]
    });
    render(
      <ReadinessPanel
        deliverable={plan}
        readiness={assess(plan)}
        engine={{
          rank: 6,
          totalScore: 65,
          eligible: false,
          exclusionReasons: ["Only 0 compatible minutes are available"],
          recommendedMinutes: null,
          recommended: false
        }}
      />
    );
    expect(
      screen.getByText(/60 minutes remaining across the deliverable\. 1 action can be worked on now\./)
    ).toBeTruthy();
    expect(screen.getByTestId("engine-opinion").textContent).toBe(
      "Can't be worked on now: Only 0 compatible minutes are available."
    );
  });

  it("says when the planner is recommending it right now", () => {
    const plan = deliverable({ steps: [step("a")], criteria: [criterion("c", { stepIds: ["a"] })] });
    render(
      <ReadinessPanel
        deliverable={plan}
        readiness={assess(plan)}
        engine={{
          rank: 1,
          totalScore: 71,
          eligible: true,
          exclusionReasons: [],
          recommendedMinutes: 45,
          recommended: true
        }}
      />
    );
    expect(screen.getByTestId("engine-opinion").textContent).toBe("Recommended now, for 45 min.");
  });
});

describe("plannerOpinionText", () => {
  const opinion = (over: Partial<Parameters<typeof plannerOpinionText>[0] & object> = {}) => ({
    rank: 43,
    totalScore: 12.34,
    eligible: true,
    exclusionReasons: [],
    recommendedMinutes: null,
    recommended: false,
    ...over
  });

  it("covers a deliverable the planner has not looked at and one outside the current plan", () => {
    expect(plannerOpinionText(undefined)).toBe("Not looked at by the planner yet.");
    expect(plannerOpinionText(null)).toBe("Not in the current plan.");
  });

  it("recommends without rank or score, with or without minutes", () => {
    expect(plannerOpinionText(opinion({ recommended: true, recommendedMinutes: 45 }))).toBe(
      "Recommended now, for 45 min."
    );
    expect(plannerOpinionText(opinion({ recommended: true }))).toBe("Recommended now.");
  });

  it("says other work comes first without the rank or score", () => {
    const text = plannerOpinionText(opinion());
    expect(text).toBe("Could be worked on now, but other work comes first.");
    expect(text).not.toMatch(/rank|score|43|12/i);
  });

  it("reads instants inside the planner's reasons in the person's zone", () => {
    const text = plannerOpinionText(
      opinion({ eligible: false, exclusionReasons: ["Resting after a full session until 2026-10-27T05:00:00.000Z."] }),
      "Australia/Sydney"
    );
    expect(text).toBe("Can't be worked on now: Resting after a full session until Tue, 27 Oct at 4:00 pm.");
    expect(text).not.toContain("T05:00");
  });

  it("falls back to a plain line when no reason is given", () => {
    expect(plannerOpinionText(opinion({ eligible: false }))).toBe("Can't be worked on now: no reason given.");
  });
});
