// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Badge } from "./badge";

describe("Badge", () => {
  it("shows its text, with a decorative dot by default", () => {
    const { container } = render(<Badge tone="warn">Late</Badge>);
    expect(screen.getByText("Late")).toBeTruthy();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("drops the dot when asked", () => {
    const { container } = render(<Badge dot={false}>Plain</Badge>);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("looks different per tone", () => {
    render(
      <>
        <Badge>One</Badge>
        <Badge tone="danger">Two</Badge>
      </>
    );
    expect(screen.getByText("One").className).not.toBe(screen.getByText("Two").className);
  });
});
