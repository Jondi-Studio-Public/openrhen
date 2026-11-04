// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { CaptureForm } from "./capture-form";

afterEach(() => window.localStorage.clear());

describe("CaptureForm", () => {
  it("saves trimmed text, clears the box and reports back", async () => {
    const addCapture = vi.fn().mockResolvedValue(undefined);
    const onSaved = vi.fn();
    render(<CaptureForm addCapture={addCapture} onSaved={onSaved} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "  Renew passport  " } });
    await act(async () => {
      fireEvent.submit(box.closest("form")!);
    });
    expect(addCapture).toHaveBeenCalledWith("Renew passport");
    expect(box.value).toBe("");
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("does nothing for blank text and shows the failure when the save rejects", async () => {
    const addCapture = vi.fn().mockRejectedValue(new Error("Offline"));
    render(<CaptureForm addCapture={addCapture} id="capture-sheet-text" />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    expect(box.id).toBe("capture-sheet-text");
    await act(async () => {
      fireEvent.submit(box.closest("form")!);
    });
    expect(addCapture).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "Call the bank" } });
    await act(async () => {
      fireEvent.submit(box.closest("form")!);
    });
    expect(screen.getByRole("alert").textContent).toBe("Offline");
    expect(box.value).toBe("Call the bank");
  });

  it("keeps a half-typed draft across an unmount and remount, as the sheet closing and reopening does", () => {
    const addCapture = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(<CaptureForm addCapture={addCapture} id="capture-sheet-text" />);
    let box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Half-typed note" } });
    unmount();

    render(<CaptureForm addCapture={addCapture} id="capture-sheet-text" />);
    box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    expect(box.value).toBe("Half-typed note");

    // Leave the draft cleared so later tests in this file start from a blank slate.
    fireEvent.change(box, { target: { value: "" } });
  });

  it("disables submit and ignores a second tap while the first save is still in flight", async () => {
    let resolveSave: () => void = () => {};
    const addCapture = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    render(<CaptureForm addCapture={addCapture} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Renew passport" } });
    const form = box.closest("form")!;
    const button = screen.getByRole("button", { name: "Add to Captured" }) as HTMLButtonElement;

    fireEvent.submit(form);
    await act(async () => {});
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");

    // A second tap while the save is still pending must not fire a second, duplicate proposal.
    fireEvent.submit(form);
    await act(async () => {});
    expect(addCapture).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveSave();
    });
    expect(button.getAttribute("aria-busy")).toBe("false");
    // The box is cleared once saved, so the button waits for the next thought.
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Book dentist" } });
    expect(button.disabled).toBe(false);
  });

  it("keeps submit disabled until something is typed", () => {
    render(<CaptureForm addCapture={vi.fn()} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment");
    const button = screen.getByRole("button", { name: "Add to Captured" }) as HTMLButtonElement;
    fireEvent.change(box, { target: { value: "" } });
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Pay rego" } });
    expect(button.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "" } });
  });

  it("sends on Ctrl+Enter and Cmd+Enter, and leaves a plain Enter to add a line", async () => {
    const addCapture = vi.fn().mockResolvedValue("c1");
    render(<CaptureForm addCapture={addCapture} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Buy printer ink" } });
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(addCapture).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    expect(addCapture).toHaveBeenCalledWith("Buy printer ink");
    expect(box.value).toBe("");

    fireEvent.change(box, { target: { value: "Call the bank" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    });
    expect(addCapture).toHaveBeenLastCalledWith("Call the bank");
  });

  it("puts the cursor back in the box after saving and reports the text and id", async () => {
    const addCapture = vi.fn().mockResolvedValue("c9");
    const onSaved = vi.fn();
    render(<CaptureForm addCapture={addCapture} onSaved={onSaved} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Renew passport" } });
    screen.getByRole("button", { name: "Add to Captured" }).focus();
    await act(async () => {
      fireEvent.submit(box.closest("form")!);
    });
    expect(document.activeElement).toBe(box);
    expect(onSaved).toHaveBeenCalledWith({ text: "Renew passport", id: "c9" });
  });

  it("tells its owner when typing starts again", () => {
    const onType = vi.fn();
    render(<CaptureForm addCapture={vi.fn()} onType={onType} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment");
    fireEvent.change(box, { target: { value: "a" } });
    expect(onType).toHaveBeenCalledTimes(1);
    fireEvent.change(box, { target: { value: "" } });
  });

  it("does not send on the Enter that confirms an IME composition", async () => {
    const addCapture = vi.fn().mockResolvedValue("c1");
    render(<CaptureForm addCapture={addCapture} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment");
    fireEvent.change(box, { target: { value: "買い物" } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true, keyCode: 229 });
    await act(async () => {});
    expect(addCapture).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: "" } });
  });

  it("sends once when Ctrl+Enter repeats in the same tick", async () => {
    const addCapture = vi.fn().mockResolvedValue("c1");
    render(<CaptureForm addCapture={addCapture} />);
    const box = screen.getByLabelText("Task, deadline, idea, or commitment");
    fireEvent.change(box, { target: { value: "Pay rego" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    expect(addCapture).toHaveBeenCalledTimes(1);
  });
});
