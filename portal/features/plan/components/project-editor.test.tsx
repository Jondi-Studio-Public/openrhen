// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { emptyProject } from "@/features/plan/plan-drafts";
import { ProjectEditor } from "@/features/plan/components/project-editor";

const seed = () => createSeedState(new Date("2026-08-18T09:00:00.000Z"));
const editor = (props: Partial<Parameters<typeof ProjectEditor>[0]> = {}) => (
  <ProjectEditor
    draft={emptyProject()}
    outcomes={seed().outcomes}
    onChange={() => {}}
    onSubmit={() => {}}
    onCancel={() => {}}
    {...props}
  />
);

describe("ProjectEditor", () => {
  it("offers both deadlines, because the internal one is the one being defended", () => {
    render(editor());
    expect(screen.getByLabelText("Internal deadline")).toBeTruthy();
    expect(screen.getByLabelText("External deadline")).toBeTruthy();
  });

  it("keeps the effort override as typed text so an empty box stays empty", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    const input = screen.getByLabelText("Remaining effort override");
    expect(input.getAttribute("placeholder")).toBe("Use action estimates");
    fireEvent.change(input, { target: { value: "240" } });
    expect(onChange).toHaveBeenCalledWith({ ...emptyProject(), remainingEffortOverrideMinutes: "240" });
  });

  it("names the three degrees of uncertainty a project can be in", () => {
    const onChange = vi.fn();
    render(editor({ onChange }));
    const select = screen.getByLabelText<HTMLSelectElement>("Uncertainty");
    expect([...select.options].map((option) => option.value)).toEqual(["known", "some", "high"]);
    fireEvent.change(select, { target: { value: "high" } });
    expect(onChange).toHaveBeenCalledWith({ ...emptyProject(), uncertainty: "high" });
  });

  it("toggles Private when nothing above it is private", () => {
    const onChange = vi.fn();
    render(editor({ onChange, areas: seed().areas }));
    const checkbox = screen.getByLabelText<HTMLInputElement>("Private");
    expect(checkbox.checked).toBe(false);
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith({ ...emptyProject(), private: true });
  });

  it("shows Private as inherited and undoable once the area is private", () => {
    const areas = seed().areas.map((area) => (area.id === "area-home" ? { ...area, private: true } : area));
    render(editor({ draft: { ...emptyProject(), outcomeId: "outcome-room" }, areas }));
    const checkbox = screen.getByLabelText<HTMLInputElement>("Private");
    expect(checkbox.checked).toBe(true);
    expect(checkbox.disabled).toBe(true);
    expect(screen.getByText("Private through Home and administration.")).toBeTruthy();
  });
});
