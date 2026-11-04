// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { Switch } from "./switch";

describe("Switch", () => {
  it("is a named switch reflecting checked", () => {
    const { rerender } = render(<Switch checked={false} onChange={() => {}} label="Notifications" />);
    expect(screen.getByRole("switch", { name: "Notifications" }).getAttribute("aria-checked")).toBe("false");
    rerender(<Switch checked onChange={() => {}} label="Notifications" />);
    expect(screen.getByRole("switch", { name: "Notifications" }).getAttribute("aria-checked")).toBe("true");
  });

  it("asks for the opposite value when clicked", () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} label="Sound" />);
    fireEvent.click(screen.getByRole("switch", { name: "Sound" }));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does nothing when disabled", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Locked" disabled />);
    fireEvent.click(screen.getByRole("switch", { name: "Locked" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
