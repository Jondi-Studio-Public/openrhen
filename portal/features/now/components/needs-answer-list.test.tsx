// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import type { NowCandidate } from "@/features/now/now-model";
import { NeedsAnswerList } from "./needs-answer-list";

const now = new Date("2026-08-18T10:00:00.000Z");
const base = createSeedState(now);
const state: PortalState = {
  ...base,
  conditionDefinitions: [
    {
      id: "ctx-laptop",
      name: "Laptop",
      kind: "capability",
      status: "active",
      pathways: [],
      portability: "portable",
      grants: [],
      setupBeforeMinutes: 0,
      transitionAfterMinutes: 0,
      channels: []
    }
  ]
};

const candidate = (unknowns: string[]): NowCandidate => ({
  action: base.actions[0]!,
  eligible: false,
  exclusionReasons: [],
  recommendedMinutes: null,
  totalScore: 0,
  scoreComponents: {},
  conditionMatch: { status: "unknown", missing: [], unknowns, unmetPreferences: [] }
});

describe("NeedsAnswerList", () => {
  it("names the missing answer using the person's own word for the context", () => {
    render(<NeedsAnswerList items={[candidate(["ctx-laptop"])]} state={state} />);
    expect(screen.getByRole("heading", { name: "Needs a quick answer" })).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("Waiting on Laptop")).toBeTruthy();
    expect(screen.getByText(/Answer in your situation/)).toBeTruthy();
  });

  it("shows at most five, so the list stays a prompt rather than a backlog", () => {
    render(<NeedsAnswerList items={Array.from({ length: 7 }, () => candidate(["ctx-laptop"]))} state={state} />);
    // The count is the whole backlog; only five rows are listed.
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getAllByText("Waiting on Laptop")).toHaveLength(5);
  });
});
