// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { CompletionPanel } from "./completion-panel";
import { deliverable, step } from "@/features/deliverables/test-fixtures";

const completed = () =>
  deliverable({
    status: "completed",
    completedAt: "2026-08-25T09:30:00.000Z",
    criteria: [
      { id: "c1", key: "c1", title: "Models done", required: true, state: "satisfied", sortOrder: 0, stepIds: [] },
      { id: "c2", key: "c2", title: "PDFs submitted", required: true, state: "satisfied", sortOrder: 1, stepIds: [] }
    ]
  });

describe("CompletionPanel", () => {
  it("states the closure, the satisfied contract and what it unlocked", () => {
    render(
      <CompletionPanel
        deliverable={completed()}
        projectTitle="Complete ABC10003"
        unlocked={[deliverable({ id: "next", title: "Assessment 3" })]}
        timezone="Australia/Sydney"
        overlay={false}
        onBack={() => {}}
      />
    );
    expect(screen.getByText("Completed")).toBeTruthy();
    expect(screen.getByText("Complete ABC10003")).toBeTruthy();
    expect(screen.getByText(/2\/2 criteria satisfied/)).toBeTruthy();
    expect(screen.getByText("Completing this unlocked:")).toBeTruthy();
    expect(screen.getByText("Assessment 3")).toBeTruthy();
    expect(screen.getByRole("link", { name: "See what's next on Now" })).toBeTruthy();
    // Not the celebration: no dialog, no Stay here.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stay here" })).toBeNull();
  });

  it("celebrates as a dismissible dialog at the moment of completion", () => {
    const onDismiss = vi.fn();
    render(
      <CompletionPanel
        deliverable={completed()}
        projectTitle={undefined}
        unlocked={[]}
        timezone="Australia/Sydney"
        overlay
        onDismiss={onDismiss}
        onBack={() => {}}
      />
    );
    expect(screen.getByRole("dialog", { name: "Deliverable completed" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it("is a keyboard-dismissible dialog: focus lands inside it and Escape calls onDismiss", () => {
    const onDismiss = vi.fn();
    render(
      <CompletionPanel
        deliverable={completed()}
        projectTitle={undefined}
        unlocked={[]}
        timezone="Australia/Sydney"
        overlay
        onDismiss={onDismiss}
        onBack={() => {}}
      />
    );
    const dialog = screen.getByRole("dialog", { name: "Deliverable completed" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("falls back to onBack for Escape when no onDismiss is given", () => {
    const onBack = vi.fn();
    render(
      <CompletionPanel
        deliverable={completed()}
        projectTitle={undefined}
        unlocked={[]}
        timezone="Australia/Sydney"
        overlay
        onBack={onBack}
      />
    );
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Deliverable completed" }), { key: "Escape" });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("leaves archived and cancelled steps out of the steps-done denominator", () => {
    render(
      <CompletionPanel
        deliverable={{
          ...completed(),
          steps: [step("a", { status: "done" }), step("b", { status: "archived" }), step("c", { status: "cancelled" })]
        }}
        projectTitle="Complete ABC10003"
        unlocked={[]}
        timezone="Australia/Sydney"
        overlay={false}
        onBack={() => {}}
      />
    );
    expect(screen.getByText(/1\/1 steps done/)).toBeTruthy();
  });
});
