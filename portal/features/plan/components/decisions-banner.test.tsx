// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { DecisionsBanner } from "@/features/plan/components/decisions-banner";

describe("DecisionsBanner", () => {
  it("stays off the page when the plan has nothing to decide", () => {
    const { container } = render(<DecisionsBanner items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("counts the decisions by kind and lists each one as a link in the sheet", () => {
    render(
      <DecisionsBanner
        items={[
          { kind: "next_step", text: "Tidy: add a next action or deliverable", href: "/plan/area-home#project-tidy" },
          { kind: "stuck", text: "Sweep: blocked", href: "/plan" }
        ]}
      />
    );
    expect(screen.getByText("2 decisions")).toBeTruthy();
    expect(screen.getByText(/1 project with no next step, 1 action blocked or waiting/)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Tidy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go through them" }));
    expect(screen.getByRole("link", { name: /Tidy: add a next action or deliverable/ }).getAttribute("href")).toBe(
      "/plan/area-home#project-tidy"
    );
    expect(screen.getByRole("link", { name: /Sweep: blocked/ }).getAttribute("href")).toBe("/plan");
  });
});
