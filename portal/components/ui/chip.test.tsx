// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { Chip } from "./chip";

describe("Chip", () => {
  it("reports its pressed state", () => {
    const { rerender } = render(<Chip pressed={false}>Home</Chip>);
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-pressed")).toBe("false");
    rerender(<Chip pressed>Home</Chip>);
    expect(screen.getByRole("button", { name: "Home" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("calls onClick", () => {
    const onClick = vi.fn();
    render(
      <Chip pressed={false} onClick={onClick}>
        Work
      </Chip>
    );
    fireEvent.click(screen.getByRole("button", { name: "Work" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
