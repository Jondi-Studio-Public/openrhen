// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { ReviewStep, StaleProjects, stepStates } from "./weekly-review";

const projects = createSeedState(new Date("2026-08-18T09:00:00.000Z")).projects;
const props = {
  projects,
  hrefOf: (project: (typeof projects)[number]) => `/plan/area#project-${project.id}`,
  describe: () => "Home · 2 open actions",
  openActions: () => ["Ring the broker", "Renew the rego", "Book a service"],
  busy: null
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("stepStates", () => {
  it("ticks off empty steps and makes the first with work current, the rest later", () => {
    expect(stepStates([false, true, true])).toEqual(["done", "current", "later"]);
    expect(stepStates([true, false, true])).toEqual(["current", "done", "later"]);
    expect(stepStates([false, false, false])).toEqual(["done", "done", "done"]);
  });
});

describe("ReviewStep", () => {
  it("numbers a later step and ticks a done one", () => {
    const { rerender } = render(<ReviewStep number={3} state="later" title="Choose focus" summary="None yet." />);
    expect(screen.getByRole("region", { name: "Step 3: Choose focus" }).textContent).toContain("3");
    expect(screen.getByRole("heading", { name: /Choose focus/ }).textContent).not.toContain("(done)");
    rerender(<ReviewStep number={3} state="done" title="Choose focus" summary="Chosen." />);
    expect(screen.getByRole("heading", { name: /Choose focus/ }).textContent).toContain("(done)");
  });
});

describe("StaleProjects", () => {
  it("lists every project on a desk, each title a link to its card in Plan", () => {
    const onChoose = vi.fn();
    render(<StaleProjects {...props} onChoose={onChoose} oneAtATime={false} />);
    for (const project of projects)
      expect(screen.getByRole("link", { name: project.title }).getAttribute("href")).toBe(
        `/plan/area#project-${project.id}`
      );
    fireEvent.click(screen.getAllByRole("button", { name: "Pause" })[1]!);
    expect(onChoose).toHaveBeenCalledWith(projects[1], "pause");
  });

  it("shows one project at a time on a phone, with its first open actions", () => {
    const onChoose = vi.fn();
    render(<StaleProjects {...props} onChoose={onChoose} oneAtATime />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: projects[0]!.title })).toBeTruthy();
    expect(screen.getByText("Ring the broker")).toBeTruthy();
    expect(screen.getByText("and 1 more")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    expect(onChoose).toHaveBeenCalledWith(projects[0], "drop");
  });

  it("holds every choice while one is being saved", () => {
    render(<StaleProjects {...props} busy="x" onChoose={() => {}} oneAtATime={false} />);
    for (const button of screen.getAllByRole("button")) expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
