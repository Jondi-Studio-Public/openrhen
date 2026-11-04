// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("shows the title alone", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(1);
  });

  it("shows body and action when given", () => {
    render(<EmptyState title="No tasks" body="Add one to begin." action={<button>Add task</button>} />);
    expect(screen.getByText("Add one to begin.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add task" })).toBeTruthy();
  });
});
