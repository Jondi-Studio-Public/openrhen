import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import {
  clock,
  directiveProjectId,
  formatConditionList,
  formatRemaining,
  hoursMinutes,
  localClockMinutes,
  projectTitle,
  travelSourceLabel,
  wallClock
} from "./now-formatting";

const state = (): PortalState => createSeedState(new Date("2026-08-18T02:30:00.000Z"));

const context = (id: string, name: string): PortalState["conditionDefinitions"][number] => ({
  id,
  name,
  kind: "location",
  status: "active",
  pathways: [],
  portability: "fixed",
  grants: [],
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0,
  channels: []
});

describe("now formatting", () => {
  it("calls the engine's 30-minute fallback a guess, and keeps 'reversed' for a derived return journey", () => {
    expect(travelSourceLabel("default")).toBe("a rough 30-minute guess");
    expect(travelSourceLabel("default")).not.toContain("reversed");
    expect(travelSourceLabel("assumed")).toBe("the way there, reversed");
  });

  it("counts a session down, and up again once it runs over", () => {
    expect(formatRemaining(90)).toBe("1:30");
    expect(formatRemaining(5)).toBe("0:05");
    expect(formatRemaining(-65)).toBe("+1:05");
  });

  it("says a span of minutes in hours and minutes, dropping whichever part is zero", () => {
    expect(hoursMinutes(483)).toBe("8 h 3 m");
    expect(hoursMinutes(480)).toBe("8 h");
    expect(hoursMinutes(45)).toBe("45 m");
    expect(hoursMinutes(0)).toBe("0 m");
  });

  it("names contexts the way the person named them and falls back to the raw id", () => {
    const withDefinitions: PortalState = {
      ...state(),
      conditionDefinitions: [context("ctx-home", "Home"), context("ctx-laptop", "Laptop")]
    };
    expect(formatConditionList(["ctx-home"], withDefinitions)).toBe("Home");
    expect(formatConditionList(["ctx-home", "ctx-laptop", "ctx-unknown"], withDefinitions)).toBe(
      "Home, Laptop and ctx-unknown"
    );
    expect(formatConditionList([], withDefinitions)).toBe("");
  });

  it("reads a stored wall-clock setting as a twelve-hour time", () => {
    expect(wallClock("06:00")).toBe("6:00 am");
    expect(wallClock("13:05")).toBe("1:05 pm");
    expect(wallClock("00:30")).toBe("12:30 am");
  });

  it("reads clock times in the configured timezone rather than the machine's", () => {
    const at = new Date("2026-08-18T02:30:00.000Z");
    expect(clock(at, "Australia/Sydney")).toMatch(/12:30/);
    expect(localClockMinutes(at, "Australia/Sydney")).toBe(12 * 60 + 30);
    expect(localClockMinutes(at, "UTC")).toBe(2 * 60 + 30);
  });

  it("labels a project, says so when the id is dangling, and stays quiet when there is none", () => {
    expect(projectTitle(state(), "networking-assignment")).toBe("Submit Networking Assignment 2");
    expect(projectTitle(state(), "missing-project")).toBe("Unknown project");
    expect(projectTitle(state(), undefined)).toBeUndefined();
  });

  it("follows a directive to the project it belongs to", () => {
    const current = state();
    expect(directiveProjectId(current, { kind: "action", targetId: "networking-section-one" })).toBe(
      "networking-assignment"
    );
    expect(directiveProjectId(current, { kind: "commitment", targetId: "dinner" })).toBeUndefined();
    expect(directiveProjectId(current, { kind: "recovery", targetId: "" })).toBeUndefined();
  });
});
