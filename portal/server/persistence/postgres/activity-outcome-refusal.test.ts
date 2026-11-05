import { describe, expect, it } from "vitest";
import { activityOutcomeRefusal } from "./activity-outcome-refusal";

describe("activityOutcomeRefusal", () => {
  it("allows stopped on a deliverable and skipped on a routine step, and every other outcome anywhere", () => {
    expect(activityOutcomeRefusal("stopped", "deliverable")).toBeNull();
    expect(activityOutcomeRefusal("skipped", "routine_step")).toBeNull();
    for (const target of ["deliverable", "routine_step", "sleep", "fixed_commitment"])
      for (const outcome of ["completed", "blocked", "did_not_start"])
        expect(activityOutcomeRefusal(outcome, target)).toBeNull();
  });

  it("refuses stopped on a non-deliverable, naming the outcomes that target takes", () => {
    const message = activityOutcomeRefusal("stopped", "fixed_commitment") ?? "";
    expect(message).toContain("Only a deliverable session can be stopped with its work still open");
    expect(message).toContain("completed, blocked or did_not_start");
    expect(message).not.toContain("skipped");
    expect(activityOutcomeRefusal("stopped", "sleep")).toContain("completed, blocked or did_not_start");
    expect(activityOutcomeRefusal("stopped", "routine_step")).toContain("completed, blocked, did_not_start or skipped");
  });

  it("refuses skipped on anything but a routine step, naming the outcomes that target takes", () => {
    const message = activityOutcomeRefusal("skipped", "deliverable") ?? "";
    expect(message).toContain("Only a routine step's own preparation can be skipped");
    expect(message).toContain("completed, stopped, blocked or did_not_start");
    expect(activityOutcomeRefusal("skipped", "sleep")).toContain("completed, blocked or did_not_start");
  });
});
