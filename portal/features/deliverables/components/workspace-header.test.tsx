// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { WorkspaceHeader } from "./workspace-header";
import { deliverable } from "@/features/deliverables/test-fixtures";

describe("WorkspaceHeader", () => {
  it("marks the read-only view and offers the way back", () => {
    const onBack = vi.fn();
    render(
      <WorkspaceHeader
        deliverable={deliverable()}
        projectTitle="Networking unit"
        phase="Carry out"
        mode="view"
        currentStepTitle={undefined}
        dirty={false}
        onBack={onBack}
      />
    );
    expect(screen.getByText("NETWORKING UNIT · DO THE WORK · READ-ONLY VIEW")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "All deliverables" }));
    expect(onBack).toHaveBeenCalled();
  });

  it("names the current step and the save state inside a session", () => {
    render(
      <WorkspaceHeader
        deliverable={deliverable()}
        projectTitle={undefined}
        phase="Carry out"
        mode="session"
        currentStepTitle="Build the diagram"
        dirty
        onBack={() => {}}
      />
    );
    expect(screen.getByText("Current action: Build the diagram")).toBeTruthy();
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    const strip = screen.getByLabelText("Stage progress");
    expect(strip.querySelector(".active")?.textContent).toContain("Do the work");
  });

  it("shows the close control it is given beside the way back", () => {
    render(
      <WorkspaceHeader
        deliverable={deliverable()}
        projectTitle={undefined}
        phase="Carry out"
        mode="session"
        currentStepTitle={undefined}
        dirty={false}
        onBack={vi.fn()}
        closeControl={<button type="button">Close slot</button>}
      />
    );
    expect(screen.getByRole("button", { name: "Close slot" })).toBeTruthy();
  });
});
