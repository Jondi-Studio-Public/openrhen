// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { closeGoTo, openGoTo } from "@/shared/use-go-to";
import { closeCaptureSheet, useCaptureSheet } from "@/shared/use-capture-sheet";
import { GoToPalette } from "./go-to-palette";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function SheetProbe() {
  const sheet = useCaptureSheet();
  return <p>{sheet.open ? `sheet open: ${sheet.mode}` : "sheet closed"}</p>;
}

afterEach(() => {
  act(() => closeGoTo());
  act(() => closeCaptureSheet());
  push.mockClear();
});

describe("GoToPalette", () => {
  it("opens on Ctrl K and Cmd K", () => {
    render(<GoToPalette />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.getByRole("dialog", { name: "Go to" })).toBeTruthy();
    act(() => closeGoTo());
    fireEvent.keyDown(window, { key: "K", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Go to" })).toBeTruthy();
  });

  it("filters as you type and opens the highlighted result on Enter", () => {
    render(<GoToPalette />);
    act(() => openGoTo());
    const input = screen.getByRole("combobox", { name: "Go to" });
    fireEvent.change(input, { target: { value: "sleep" } });
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("Sleep log");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/settings/sleep");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not open a result when Enter commits an IME composition", () => {
    render(<GoToPalette />);
    act(() => openGoTo());
    const input = screen.getByRole("combobox", { name: "Go to" });
    fireEvent.change(input, { target: { value: "sleep" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Go to" })).toBeTruthy();
  });

  it("names options by position, so ids hold no slashes or hashes", () => {
    render(<GoToPalette />);
    act(() => openGoTo());
    const input = screen.getByRole("combobox", { name: "Go to" });
    for (const option of screen.getAllByRole("option")) expect(option.id).toMatch(/^[^/#]+$/);
    expect(document.getElementById(input.getAttribute("aria-activedescendant")!)).toBe(
      screen.getAllByRole("option")[0]
    );
  });

  it("scrolls the highlighted row into view as the arrow keys move it", () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent ?? "");
    };
    try {
      render(<GoToPalette />);
      act(() => openGoTo());
      const input = screen.getByRole("combobox", { name: "Go to" });
      for (let step = 0; step < 12; step += 1) fireEvent.keyDown(input, { key: "ArrowDown" });
      const option = screen.getAllByRole("option")[12]!;
      expect(option.getAttribute("aria-selected")).toBe("true");
      expect(scrolled.at(-1)).toBe(option.textContent);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it("says so when nothing matches", () => {
    render(<GoToPalette />);
    act(() => openGoTo());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "qqqq" } });
    expect(screen.getByText(/Nothing called that/)).toBeTruthy();
  });

  it("opens a result on click and closes on Escape", () => {
    render(<GoToPalette />);
    act(() => openGoTo());
    fireEvent.click(screen.getByRole("option", { name: /Connections/ }));
    expect(push).toHaveBeenCalledWith("/connections");
    act(() => openGoTo());
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the capture sheet, not a page, when Capture a thought is chosen", async () => {
    render(
      <>
        <GoToPalette />
        <SheetProbe />
      </>
    );
    act(() => openGoTo());
    const input = screen.getByRole("combobox", { name: "Go to" });
    fireEvent.change(input, { target: { value: "capture" } });
    expect(screen.getAllByRole("option")[0]!.textContent).toContain("Capture a thought");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("sheet open: capture")).toBeTruthy());
    expect(screen.queryByRole("dialog", { name: "Go to" })).toBeNull();
  });

  it("opens the disruption half for Something came up", async () => {
    render(
      <>
        <GoToPalette />
        <SheetProbe />
      </>
    );
    act(() => openGoTo());
    fireEvent.click(screen.getByRole("option", { name: /Something came up/ }));
    await waitFor(() => expect(screen.getByText("sheet open: disruption")).toBeTruthy());
  });
});
