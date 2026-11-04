// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { NothingFitsPanel } from "./nothing-fits-panel";

describe("NothingFitsPanel", () => {
  it("points at where work can be added, and why nothing fits now", () => {
    render(<NothingFitsPanel explanation="No action fits this window." evidence={["Every action needs a laptop"]} />);
    expect(screen.getByText("No action fits this window. Add or adjust work in Capture and Plan.")).toBeTruthy();
    expect(screen.getByText("Why nothing fits")).toBeTruthy();
    expect(screen.getByText("Every action needs a laptop")).toBeTruthy();
  });

  it("does not blame the plan when the engine did not say the work is the problem", () => {
    render(<NothingFitsPanel explanation="No action fits this window." evidence={[]} workIsTheProblem={false} />);
    expect(screen.getByText("No action fits this window.")).toBeTruthy();
    expect(screen.queryByText(/Add or adjust work/)).toBeNull();
  });

  it("shows no list when the engine offered no evidence", () => {
    render(<NothingFitsPanel explanation="No action fits this window." evidence={[]} />);
    expect(screen.queryByText("Why nothing fits")).toBeNull();
  });
});
