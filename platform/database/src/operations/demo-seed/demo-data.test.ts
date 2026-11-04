import { describe, expect, it } from "vitest";
import { ACTIONS, CONDITIONS, DELIVERABLES, OUTCOMES, PRESETS, PROJECTS } from "./demo-data-planning.js";
import { COMMITMENTS, HISTORY, RULES, SETUP_SETTINGS } from "./demo-data-schedule.js";
import { KEPT_CAPTURES, classifiedCapture, plainCaptures, proposals } from "./demo-data-inbox.js";
import { extraCaptures } from "./demo-capture-extensions.js";
import { demoCalendarImports } from "./demo-calendar-imports.js";
import "./private/index.js";
import { createShifter } from "./demo-dates.js";

function strings(value: unknown, into: string[] = []): string[] {
  if (typeof value === "string") into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === "object") for (const item of Object.values(value)) strings(item, into);
  return into;
}

// The anchor day itself: a shift of zero days, so every authored datetime must come back untouched.
const shifter = createShifter(new Date("2026-10-27T16:00:00Z"));

const fixtures: Record<string, unknown> = {
  CONDITIONS,
  OUTCOMES,
  PROJECTS,
  DELIVERABLES,
  PRESETS,
  ACTIONS,
  RULES,
  COMMITMENTS,
  HISTORY,
  SETUP_SETTINGS,
  KEPT_CAPTURES,
  plainCaptures: plainCaptures(shifter),
  classifiedCapture: classifiedCapture("p"),
  extraCaptures: extraCaptures(shifter, "d"),
  proposals: proposals(shifter, "h", "d"),
  calendarImports: demoCalendarImports()
};

describe("demo seed data", () => {
  it("writes every authored datetime with the demo zone's offset", () => {
    const wrong: string[] = [];
    for (const [name, fixture] of Object.entries(fixtures))
      for (const text of strings(fixture)) if (shifter.value(text) !== text) wrong.push(`${name}: ${text}`);
    expect(wrong).toEqual([]);
  });

  it("keeps the demo persona in its own country", () => {
    // The demo person lives in the US (America/New_York); fixtures must not drift back to another country's
    // place names. Real local places are kept out by review, not by a list in this file.
    const stray = /\b(?:Australia|Australian|NSW|Queensland|Melbourne)\b/i;
    const found: string[] = [];
    for (const [name, fixture] of Object.entries(fixtures))
      for (const text of strings(fixture)) if (stray.test(text)) found.push(`${name}: ${text}`);
    expect(found).toEqual([]);
  });
});
