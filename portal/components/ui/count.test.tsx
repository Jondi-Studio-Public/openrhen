// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Count } from "./count";

describe("Count", () => {
  it("renders the number", () => {
    render(<Count value={12} />);
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("passes aria-label through so the number can be spoken in context", () => {
    render(<Count value={3} aria-label="3 unread" />);
    expect(screen.getByLabelText("3 unread").textContent).toBe("3");
  });

  it("marks a hot count differently", () => {
    render(
      <>
        <Count value={1} />
        <Count value={2} hot />
      </>
    );
    expect(screen.getByText("1").className).not.toBe(screen.getByText("2").className);
  });
});
