import { describe, expect, it } from "vitest";
import { withValidationIssues } from "./validation-message";

describe("withValidationIssues", () => {
  it("names the field and the problem after the route's sentence", () => {
    expect(
      withValidationIssues("Project command validation failed.", [{ path: ["project", "name"], message: "Required" }])
    ).toBe("Project command validation failed. project.name: Required");
  });

  it("shows two issues and counts the rest", () => {
    const issues = [1, 2, 3, 4].map((n) => ({ path: [`f${n}`], message: "Bad" }));
    expect(withValidationIssues("Failed.", issues)).toBe("Failed. f1: Bad; f2: Bad (and 2 more)");
  });

  it("leaves the sentence alone when there are no usable issues", () => {
    expect(withValidationIssues("Failed.", undefined)).toBe("Failed.");
    expect(withValidationIssues("Failed.", [])).toBe("Failed.");
    expect(withValidationIssues("Failed.", [{ path: ["a"] }])).toBe("Failed.");
  });

  it("uses the message alone for a whole-body issue", () => {
    expect(withValidationIssues("Failed.", [{ path: [], message: "Invalid input" }])).toBe("Failed. Invalid input");
  });
});
