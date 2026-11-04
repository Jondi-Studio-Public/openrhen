// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import type { AnswerDirective, AnswerOption } from "@/features/now/now-model";
import { AnswerPanel } from "./answer-panel";

const now = new Date("2026-08-18T10:00:00.000Z");
const state: PortalState = {
  ...createSeedState(now),
  currentSituation: {
    locationId: null,
    overrides: {},
    carrying: { laptop: false },
    transportModes: ["car"],
    travel: {},
    travelOff: false
  }
};
const directive: AnswerDirective = {
  kind: "answer",
  title: "Answer: is the laptop with you?",
  recommendedMinutes: 0,
  question: "Is the laptop with you?",
  contextIds: ["laptop"],
  candidate: { kind: "action", targetId: "a1", title: "Draft the report", recommendedMinutes: 40 }
};
const options: AnswerOption[] = [
  { contextId: "laptop", name: "Laptop", kind: "carrying" },
  { contextId: "home", name: "Home", kind: "location" },
  { contextId: "printer", name: "Printer", kind: "override" }
];

describe("AnswerPanel", () => {
  it("shows the question and what would lead if the answer were yes", () => {
    render(
      <AnswerPanel
        directive={directive}
        options={options}
        state={state}
        saving={false}
        explanation="Only an unanswered context stands in the way."
        evidence={["Laptop: not answered yet"]}
        saveEntityCommand={vi.fn().mockResolvedValue(undefined)}
      />
    );
    expect(screen.getByText("Is the laptop with you?")).toBeTruthy();
    expect(screen.getByText("Draft the report")).toBeTruthy();
    expect(screen.getByText(/would lead for 40 minutes/)).toBeTruthy();
    expect(screen.getByText("Why nothing else fits")).toBeTruthy();
  });

  it("answers through the situation commands: carrying, location, and override", () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <AnswerPanel
        directive={directive}
        options={options}
        state={state}
        saving={false}
        explanation=""
        evidence={[]}
        saveEntityCommand={save}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Yes, with me" }));
    expect(save.mock.calls[0]![0].entity.currentSituation).toEqual({ carrying: { laptop: true } });
    fireEvent.click(screen.getByRole("button", { name: "I am at Home" }));
    expect(save.mock.calls[1]![0].entity.currentSituation).toEqual({ locationId: "home" });
    fireEvent.click(screen.getByRole("button", { name: "No, not available" }));
    expect(save.mock.calls[2]![0].entity.currentSituation).toEqual({ overrides: { printer: "unavailable" } });
    expect(save.mock.calls.every((call) => call[0].entityType === "current_availability")).toBe(true);
  });

  it("says so when the engine named no candidate", () => {
    render(
      <AnswerPanel
        directive={{ ...directive, candidate: null }}
        options={options}
        state={state}
        saving={false}
        explanation=""
        evidence={[]}
        saveEntityCommand={vi.fn()}
      />
    );
    expect(screen.getByText(/has not named what would lead/)).toBeTruthy();
  });
});
