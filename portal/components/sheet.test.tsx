// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { Sheet } from "./sheet";

function Harness({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <>
      <button>Opener</button>
      <Sheet open={open} onClose={onClose} title="Capture">
        <input aria-label="First" />
        <button>Last</button>
      </Sheet>
    </>
  );
}

/** Mirrors a plan editor's collapsed `<summary>`: a focusable element earlier in the DOM than the
 * field that should actually take focus, hidden the way `.plan-editor-sheet .editor-card > summary`
 * is hidden in the real stylesheet. */
function HarnessWithHiddenFirst({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Capture">
      <button style={{ display: "none" }}>Hidden</button>
      <input aria-label="First" />
    </Sheet>
  );
}

/** The Add sheet's shape: mode buttons first, then a field that asks for focus itself. */
function HarnessWithAutoFocus({ open }: { open: boolean }) {
  return (
    <>
      <button>Opener</button>
      <Sheet open={open} onClose={vi.fn()} title="Add">
        <button>Mode</button>
        <textarea aria-label="Thought" autoFocus />
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("renders nothing while closed", () => {
    render(<Harness open={false} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is a labelled modal dialog that takes focus and locks body scroll", () => {
    render(<Harness open onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Capture" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(screen.getByLabelText("First"));
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("skips a display:none candidate that comes first in the DOM and focuses the first rendered one", () => {
    render(<HarnessWithHiddenFirst open onClose={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByLabelText("First"));
  });

  it("closes on Escape, on the close button, and on a backdrop click but not a click inside", () => {
    const onClose = vi.fn();
    render(<Harness open onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close Capture" }));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("wraps Tab at both ends so focus stays inside", () => {
    render(<Harness open onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    const close = screen.getByRole("button", { name: "Close Capture" });
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("returns focus to the opener and unlocks scrolling when it closes", () => {
    const { rerender } = render(<Harness open={false} onClose={vi.fn()} />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    rerender(<Harness open onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(opener);
    rerender(<Harness open={false} onClose={vi.fn()} />);
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps a field's own autoFocus, and still returns focus to the opener when it closes", () => {
    const { rerender } = render(<HarnessWithAutoFocus open={false} />);
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    rerender(<HarnessWithAutoFocus open />);
    expect(document.activeElement).toBe(screen.getByLabelText("Thought"));
    rerender(<HarnessWithAutoFocus open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  describe("motion", () => {
    afterEach(() => {
      // @ts-expect-error test-only cleanup of a stub some of these tests install
      delete window.matchMedia;
    });

    function mockReducedMotion(reduced: boolean) {
      window.matchMedia = ((query: string) =>
        ({
          matches: reduced && query.includes("prefers-reduced-motion"),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {}
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
    }

    it("opens straight into the resting state under prefers-reduced-motion, with no closing delay either", () => {
      mockReducedMotion(true);
      const { rerender } = render(<Harness open onClose={vi.fn()} />);
      expect(screen.getByRole("dialog").getAttribute("data-phase")).toBe("open");
      rerender(<Harness open={false} onClose={vi.fn()} />);
      // Closes immediately: no lingering "closing" phase waiting on a transition that reduced
      // motion never plays.
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("stays mounted through a closing transition and unmounts once it ends", () => {
      const { rerender } = render(<Harness open onClose={vi.fn()} />);
      rerender(<Harness open={false} onClose={vi.fn()} />);
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("data-phase")).toBe("closing");
      // Focus management already stopped trapping the instant `open` went false, but the sheet is
      // still mounted and visible for the exit transition — `inert` (and the pointer-events: none it
      // pairs with) is what actually stops it from still being tappable during that window.
      expect(dialog.closest("[inert]")).not.toBeNull();
      fireEvent.transitionEnd(dialog);
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    it("dismisses on a header swipe past the threshold, and does not dismiss on a shorter one", () => {
      const onClose = vi.fn();
      render(<Harness open onClose={onClose} />);
      const header = document.querySelector(".sheet-header") as HTMLElement;

      fireEvent.pointerDown(header, { pointerType: "touch", clientY: 100 });
      fireEvent.pointerMove(header, { pointerType: "touch", clientY: 140 });
      fireEvent.pointerUp(header, { pointerType: "touch", clientY: 140 });
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.pointerDown(header, { pointerType: "touch", clientY: 100 });
      fireEvent.pointerMove(header, { pointerType: "touch", clientY: 260 });
      fireEvent.pointerUp(header, { pointerType: "touch", clientY: 260 });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores a mouse drag on the header", () => {
      const onClose = vi.fn();
      render(<Harness open onClose={onClose} />);
      const header = document.querySelector(".sheet-header") as HTMLElement;
      fireEvent.pointerDown(header, { pointerType: "mouse", clientY: 100 });
      fireEvent.pointerMove(header, { pointerType: "mouse", clientY: 300 });
      fireEvent.pointerUp(header, { pointerType: "mouse", clientY: 300 });
      expect(onClose).not.toHaveBeenCalled();
    });
  });
});
