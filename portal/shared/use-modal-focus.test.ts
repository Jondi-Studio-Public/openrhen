// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen } from "@/test/render";
import { Harness, HarnessWithScopedInitialFocus, HiddenTail } from "./use-modal-focus-harness";

describe("useModalFocus", () => {
  it("focuses the first focusable element in the trap and locks body scroll while active", () => {
    render(createElement(Harness, { active: true, onClose: vi.fn() }));
    expect(document.activeElement).toBe(screen.getByLabelText("First"));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("does nothing while inactive", () => {
    render(createElement(Harness, { active: false, onClose: vi.fn() }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("only searches initialFocusRef's subtree, skipping a display:none candidate that comes first in the DOM", () => {
    render(createElement(HarnessWithScopedInitialFocus, { active: true }));
    expect(document.activeElement).toBe(screen.getByLabelText("First"));
  });

  it("wraps Tab at both ends so focus stays inside the trap", () => {
    render(createElement(Harness, { active: true, onClose: vi.fn() }));
    const dialog = screen.getByRole("dialog");
    const first = screen.getByLabelText("First");
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("ignores controls hidden in a closed <details> or display:none when wrapping Tab", () => {
    render(createElement(HiddenTail));
    const dialog = screen.getByRole("dialog");
    // The closed details' summary is the last control a user can reach.
    screen.getByText("More").focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByLabelText("First"));
  });

  it("calls onClose on Escape and stops it propagating", () => {
    const onClose = vi.fn();
    render(createElement(Harness, { active: true, onClose }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener and unlocks scrolling once it goes inactive", () => {
    const { rerender } = render(createElement(Harness, { active: false, onClose: vi.fn() }));
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    rerender(createElement(Harness, { active: true, onClose: vi.fn() }));
    expect(document.activeElement).not.toBe(opener);
    rerender(createElement(Harness, { active: false, onClose: vi.fn() }));
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });
});
