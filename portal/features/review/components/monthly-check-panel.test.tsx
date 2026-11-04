// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSeedState } from "@/state/portal-state";
import { render, screen } from "@/test/render";
import { MonthlyCheckPanel } from "./monthly-check-panel";

const now = new Date("2026-09-15T00:00:00.000Z");
const seed = createSeedState(now);

function mockAreaTime(response: Response | Promise<never>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => (response instanceof Response ? Promise.resolve(response) : response))
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("MonthlyCheckPanel", () => {
  it("is folded, due until this month's focus is saved, and flags neglected areas", async () => {
    mockAreaTime(Response.json({ projects: [{ projectId: "networking-assignment", minutes: 120 }] }));
    const { container } = render(<MonthlyCheckPanel state={seed} now={now} />);
    const summary = container.querySelector("details summary")!;
    expect(container.querySelector("details")!.open).toBe(false);
    expect(summary.textContent).toContain("Monthly check · September");
    expect(summary.textContent).toContain("due");
    expect(await screen.findByText("1 neglected")).toBeTruthy();
    // Real separators in the text, not only a CSS gap, so a screen reader does not read "Septemberdue1 neglected".
    expect(summary.textContent).toBe("Monthly check · September, due, 1 neglected");
    expect(screen.getByText(/2 h recorded · 100%/)).toBeTruthy();
    expect(screen.getByText("neglected")).toBeTruthy();
    expect(screen.getByText("Choose focus").getAttribute("href")).toBe("/review/focus");
  });

  it("reads as done once a monthly focus exists for the current month", () => {
    mockAreaTime(Response.json({ projects: [] }));
    const state = {
      ...seed,
      planningFocus: [
        { id: "f1", kind: "monthly" as const, periodStart: "2026-09-01", periodEnd: "2026-09-30", projectIds: [] }
      ]
    };
    const { container } = render(<MonthlyCheckPanel state={state} now={now} />);
    expect(container.querySelector("details summary")!.textContent).not.toContain("due");
    expect(screen.getByText("Change focus")).toBeTruthy();
  });

  it("lists active outcomes, the usable-capacity assumption and paused work", () => {
    mockAreaTime(Response.json({ projects: [] }));
    const state = {
      ...seed,
      projects: seed.projects.map((project) =>
        project.id === "clean-room" ? { ...project, status: "paused" as const } : project
      )
    };
    render(<MonthlyCheckPanel state={state} now={now} />);
    expect(screen.getByText("Complete Networking Assignment 2")).toBeTruthy();
    expect(screen.getByText(/Plans treat 85% of free time as usable/)).toBeTruthy();
    expect(screen.getByText("Reset and clean my room")).toBeTruthy();
  });

  it("flags nothing as neglected when recorded time cannot be read", async () => {
    mockAreaTime(new Response(null, { status: 503 }));
    render(<MonthlyCheckPanel state={seed} now={now} />);
    expect(await screen.findByText(/Recorded time could not be read/)).toBeTruthy();
    expect(screen.queryByText(/neglected$/)).toBeNull();
  });
});
