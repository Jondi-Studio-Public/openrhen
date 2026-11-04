// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { ContextChoices } from "./context-choices";

describe("ContextChoices", () => {
  it("adds a ticked context and removes an unticked one", () => {
    const onChange = vi.fn();
    render(<ContextChoices options={["home", "laptop"]} selected={["home"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "laptop" }));
    expect(onChange).toHaveBeenCalledWith(["home", "laptop"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "home" }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it("offers a context that only exists in the import and marks where it came from", () => {
    render(<ContextChoices options={["home"]} selected={["studio"]} onChange={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: /studio/ })).toBeTruthy();
    expect(screen.getAllByText("from import").length).toBeGreaterThan(0);
    expect(screen.queryByRole("checkbox", { name: /^home$/ })).toBeTruthy();
  });

  it("summarises the selection count instead of the prompt once something is chosen", () => {
    render(<ContextChoices options={["home", "laptop"]} selected={["home", "laptop"]} onChange={vi.fn()} />);
    expect(screen.getByText("2 selected")).toBeTruthy();
  });

  it("shows only chips and no checkboxes when the record cannot be edited", () => {
    const { container } = render(<ContextChoices options={["home"]} selected={["home"]} disabled onChange={vi.fn()} />);
    expect(container.querySelector(".context-picker.disabled")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
