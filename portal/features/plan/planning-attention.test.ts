import { describe, expect, it } from "vitest";
import { createSeedState, type PortalState } from "@/state/portal-state";
import { planningAttention, summariseAttention } from "@/features/plan/planning-attention";
import { deliverable, step } from "@/features/deliverables/test-fixtures";

const seed = (): PortalState => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const texts = (state: PortalState) => planningAttention(state).map((item) => item.text);
const hrefOf = (state: PortalState, text: string) => planningAttention(state).find((item) => item.text === text)?.href;

describe("planning attention", () => {
  it("stays quiet while every active project has live work under it", () => {
    expect(planningAttention(seed())).toEqual([]);
  });

  it("names an active project that nothing can advance", () => {
    const state = seed();
    const stranded: PortalState = {
      ...state,
      actions: state.actions.filter((item) => item.projectId !== "clean-room")
    };
    expect(texts(stranded)).toContain("Reset and clean my room: add a next action or deliverable");
    // The project's own card in Plan, like Review's "Review in Plan".
    expect(hrefOf(stranded, "Reset and clean my room: add a next action or deliverable")).toBe(
      "/plan/area-home#project-clean-room"
    );
  });

  it("treats an unfinished deliverable as enough to advance a project", () => {
    const state = seed();
    const withDeliverable: PortalState = {
      ...state,
      actions: state.actions.filter((item) => item.projectId !== "clean-room"),
      deliverables: [
        {
          id: "shell",
          projectId: "clean-room",
          title: "Room reset plan",
          status: "needs_breakdown",
          uncertainty: "some",
          importance: 3,
          consequence: 3,
          contractVersion: 0,
          planVersion: 0,
          sortOrder: 0,
          dependencyIds: [],
          sourceIds: [],
          sourceFiles: [],
          steps: [],
          criteria: [],
          blockers: [],
          contractProposals: []
        }
      ]
    };
    expect(planningAttention(withDeliverable)).toEqual([]);
  });

  it("asks for a review of an estimate the engine no longer trusts", () => {
    const state = seed();
    const flagged: PortalState = {
      ...state,
      actions: state.actions.map((item) => (item.id === "room-floor" ? { ...item, estimateNeedsReview: true } : item))
    };
    expect(texts(flagged)).toContain("Sort the bedroom floor: review remaining effort");
    expect(hrefOf(flagged, "Sort the bedroom floor: review remaining effort")).toBe(
      "/plan/area-home#project-clean-room"
    );
  });

  it("asks for a review of a deliverable step that overran its estimate", () => {
    const state = seed();
    const flagged: PortalState = {
      ...state,
      deliverables: [
        deliverable({
          projectId: "clean-room",
          steps: [step("draft", { title: "Draft", estimateNeedsReview: true }), step("polish", { title: "Polish" })]
        })
      ]
    };
    expect(texts(flagged)).toContain("Assessment 2 · Draft: review remaining effort");
    expect(texts(flagged)).not.toContain("Assessment 2 · Polish: review remaining effort");
    // A step has no card of its own in Plan; it is worked in its deliverable's workspace.
    expect(hrefOf(flagged, "Assessment 2 · Draft: review remaining effort")).toBe(
      "/deliverables?deliverable=assessment-2"
    );
  });

  it("reports parked work by the state it is parked in", () => {
    const state = seed();
    const parked: PortalState = {
      ...state,
      actions: state.actions.map((item) => (item.id === "room-floor" ? { ...item, status: "waiting" as const } : item))
    };
    expect(texts(parked)).toContain("Sort the bedroom floor: waiting on something");
    expect(hrefOf(parked, "Sort the bedroom floor: waiting on something")).toBe("/plan/area-home#project-clean-room");
  });

  it("falls back to Plan for work whose project has gone", () => {
    const state = seed();
    const orphaned: PortalState = {
      ...state,
      actions: state.actions.map((item) =>
        item.id === "room-floor" ? { ...item, projectId: "gone", status: "blocked" as const } : item
      )
    };
    expect(hrefOf(orphaned, "Sort the bedroom floor: blocked")).toBe("/plan");
  });

  it("counts the items by kind for the Plan banner, one and many", () => {
    const item = (kind: "next_step" | "estimate" | "stuck") => ({ kind, text: kind, href: "/plan" });
    expect(summariseAttention([item("stuck"), item("next_step"), item("next_step"), item("estimate")])).toBe(
      "2 projects with no next step, 1 estimate to review, 1 action blocked or waiting"
    );
    expect(summariseAttention([])).toBe("");
  });
});
