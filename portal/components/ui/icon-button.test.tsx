// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { IconButton } from "./icon-button";

describe("IconButton", () => {
  it("is named by its label, not its icon", () => {
    render(
      <IconButton label="Close">
        <svg aria-hidden="true" />
      </IconButton>
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("fires onClick", () => {
    const onClick = vi.fn();
    render(
      <IconButton label="Add" onClick={onClick}>
        +
      </IconButton>
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
