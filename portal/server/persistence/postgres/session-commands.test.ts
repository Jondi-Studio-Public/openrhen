import { describe, expect, it } from "vitest";
import { InvalidCommandError } from "./command-errors";
import { assertStartableTarget, unstartableActionMessage } from "./session-commands";

describe("assertStartableTarget", () => {
  it("refuses a session on a recurring template unless an occurrence is named", () => {
    expect(() => assertStartableTarget("recurring", false)).toThrow(InvalidCommandError);
    expect(() => assertStartableTarget("recurring", false)).toThrow(/start a session on one of its occurrences/);
  });

  it("lets a recurring series start through one of its occurrences", () => {
    expect(() => assertStartableTarget("recurring", true)).not.toThrow();
  });

  it("leaves one-off and cadence actions startable directly", () => {
    expect(() => assertStartableTarget("one_off", false)).not.toThrow();
    expect(() => assertStartableTarget("cadence", false)).not.toThrow();
  });
});

describe("unstartableActionMessage", () => {
  it("names a waiting or blocked status and says to set it back to active", () => {
    for (const status of ["waiting", "blocked"])
      expect(unstartableActionMessage(status)).toBe(
        `This action is ${status}, so it cannot be started; set its status back to active first.`
      );
  });

  it("names a closed status and says to reopen it", () => {
    for (const status of ["done", "cancelled", "archived"])
      expect(unstartableActionMessage(status)).toContain(
        `This action is ${status}, so it cannot be started; reopen it`
      );
  });

  it("lets every other status through", () => {
    for (const status of ["inbox", "planned", "active", "doing"]) expect(unstartableActionMessage(status)).toBeNull();
  });
});
