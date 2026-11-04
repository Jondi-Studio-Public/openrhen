// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { openGoTo, closeGoTo } from "@/shared/use-go-to";
import { closeCaptureSheet, openCaptureSheet } from "@/shared/use-capture-sheet";

const addCapture = vi.fn();
const saveEntityCommand = vi.fn();
let captures: Record<string, unknown>[];

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state: { captures },
    addCapture,
    saveEntityCommand,
    runActivityCommand: vi.fn()
  })
}));
vi.mock("@/features/disruptions/components/disruption-capture-form", () => ({
  DisruptionCaptureForm: () => <p>disruption form</p>
}));
vi.mock("@/features/inbox/components/import-panels", () => ({
  ImportPanels: ({ panel }: { panel: string }) => <p>import panel: {panel}</p>
}));

const { registerImportPanel } = await import("@/features/imports/import-panel-extensions");
// A provider-free stand-in for a registered import tab: the sheet lists whatever is registered, between
// Workbook or CSV and Disruption, and names none itself.
registerImportPanel({ id: "example_pull", label: "Example pull", Panel: () => null });

const { CaptureSheetDialog } = await import("./capture-sheet-dialog");
const { GoToPalette } = await import("./go-to-palette");

const BOX = "Task, deadline, idea, or commitment";

beforeEach(() => {
  window.localStorage.clear();
  captures = [];
  addCapture.mockReset().mockImplementation(async () => {
    captures = [
      ...captures,
      { id: "c1", status: "pending", version: 1, proposalType: "unclassified", proposedFields: { text: "x" } }
    ];
    return "c1";
  });
  saveEntityCommand.mockReset().mockResolvedValue(undefined);
});
afterEach(() => act(() => closeCaptureSheet()));

function openSheet(mode: Parameters<typeof openCaptureSheet>[0] = "capture") {
  render(<CaptureSheetDialog />);
  act(() => openCaptureSheet(mode));
}

describe("CaptureSheetDialog", () => {
  it("offers capture, paste or photo, workbook, a registered import tab and disruption in one sheet", () => {
    openSheet();
    const group = screen.getByRole("tablist", { name: "What this is" });
    // OpenRhen' own build also registers its provider tabs (the test render loads the extension seam), so the
    // order is pinned around them: core tabs first, registered tabs next, Disruption last.
    const tabs = Array.from(group.querySelectorAll("[role=tab]")).map((button) => button.textContent);
    expect(tabs.slice(0, 3)).toEqual(["Capture", "Paste or photo", "Workbook or CSV"]);
    expect(tabs.at(-1)).toBe("Something came up");
    expect(tabs).toContain("Example pull");
  });

  it("keeps one tab stop on the mode switch and moves it with the arrow keys", () => {
    openSheet();
    const tabs = () => screen.getAllByRole("tab");
    expect(tabs().filter((tab) => tab.getAttribute("tabindex") !== "-1")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Capture" }).getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Capture" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Paste or photo" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Paste or photo" }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Capture" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(tabs().at(-1)!.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("does not carry a no-op Home into the next mode change: a click on another tab keeps focus there", () => {
    openSheet();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Capture" }), { key: "Home" });
    const paste = screen.getByRole("tab", { name: "Paste or photo" });
    paste.focus();
    fireEvent.click(paste);
    expect(paste.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(paste);
  });

  it("switches to the import panels and the disruption form", () => {
    openSheet();
    fireEvent.click(screen.getByRole("tab", { name: "Paste or photo" }));
    expect(screen.getByText("import panel: paste")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Example pull" }));
    expect(screen.getByText("import panel: example_pull")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Something came up" }));
    expect(screen.getByText("disruption form")).toBeTruthy();
  });

  it("can be opened straight onto a tab", () => {
    openSheet("paste");
    expect(screen.getByText("import panel: paste")).toBeTruthy();
  });

  it("sends on Ctrl+Enter, says Saved with the text, a count and a link, and keeps the box ready", async () => {
    openSheet();
    const box = screen.getByLabelText(BOX) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Saved: “buy printer ink” (1 capture waiting)");
    expect(status.textContent).not.toContain("Needs review");
    expect(screen.getByRole("link", { name: "See it in Captured" }).getAttribute("href")).toBe(
      "/inbox/captured?item=capture:c1"
    );
    // One way into Captured while a save is showing, not two links to the same place.
    expect(screen.queryByRole("link", { name: "Review captured items" })).toBeNull();
    expect(box.value).toBe("");
    expect(document.activeElement).toBe(box);
  });

  it("keeps the live region mounted before anything is saved, so the first Saved is announced", () => {
    openSheet();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("clears the Saved line as soon as you type the next thought", async () => {
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    });
    await screen.findByRole("status");
    fireEvent.change(box, { target: { value: "n" } });
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.change(box, { target: { value: "" } });
  });

  it("undoes the save by ignoring that capture", async () => {
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    expect(saveEntityCommand.mock.calls[0]![0]).toMatchObject({
      entityType: "capture",
      entity: { id: "c1", status: "ignored" }
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Undone"));
    // The thought is back in the box, ready to edit or send again.
    expect((screen.getByLabelText(BOX) as HTMLTextAreaElement).value).toBe("buy printer ink");
  });

  it("keeps a new thought typed while Undo is in flight, and only says it was undone", async () => {
    let finish: () => void = () => {};
    saveEntityCommand.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(saveEntityCommand).toHaveBeenCalledTimes(1));
    fireEvent.change(box, { target: { value: "call the bank" } });
    await act(async () => finish());
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Undone"));
    expect(screen.getByRole("status").textContent).toContain("Your new text is kept");
    expect((screen.getByLabelText(BOX) as HTMLTextAreaElement).value).toBe("call the bank");
    fireEvent.change(screen.getByLabelText(BOX), { target: { value: "" } });
  });

  it("leaves a capture alone on Undo when it changed after it was saved", async () => {
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    // Confirmed elsewhere (another tab, the CLI) before Undo is pressed.
    captures = captures.map((item) => ({ ...item, status: "confirmed", version: 2 }));
    act(() => openCaptureSheet("capture"));
    fireEvent.click(undo);
    expect((await screen.findByRole("alert")).textContent).toContain("Undo left it alone");
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  it("leaves a capture alone on Undo when only its version moved on", async () => {
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    const undo = await screen.findByRole("button", { name: "Undo" });
    // Still waiting, but edited elsewhere: the status branch would let this through, the version must not.
    captures = captures.map((item) => ({ ...item, version: 2 }));
    act(() => openCaptureSheet("capture"));
    fireEvent.click(undo);
    expect((await screen.findByRole("alert")).textContent).toContain("Undo left it alone");
    expect(saveEntityCommand).not.toHaveBeenCalled();
  });

  it("disables Undo while it is in flight", async () => {
    let finish: () => void = () => {};
    saveEntityCommand.mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    const undo = (await screen.findByRole("button", { name: "Undo" })) as HTMLButtonElement;
    fireEvent.click(undo);
    await waitFor(() => expect(undo.disabled).toBe(true));
    fireEvent.click(undo);
    expect(saveEntityCommand).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it("says Add or import on the import tabs", () => {
    openSheet();
    expect(screen.getByRole("heading", { name: "Capture" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Paste or photo" }));
    expect(screen.getByRole("heading", { name: "Add or import" })).toBeTruthy();
  });

  it("puts focus in the sheet when the palette opens it, and Escape returns to the trigger", async () => {
    render(
      <>
        <button>Trigger</button>
        <GoToPalette />
        <CaptureSheetDialog />
      </>
    );
    const trigger = screen.getByRole("button", { name: "Trigger" });
    trigger.focus();
    act(() => openGoTo());
    const input = screen.getByRole("combobox", { name: "Go to" });
    fireEvent.change(input, { target: { value: "capture" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(BOX)));
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Capture" }), { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    act(() => closeGoTo());
  });

  it("starts clean each time the sheet opens", async () => {
    openSheet();
    const box = screen.getByLabelText(BOX);
    fireEvent.change(box, { target: { value: "buy printer ink" } });
    await act(async () => {
      fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    });
    await screen.findByRole("status");
    act(() => closeCaptureSheet());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    act(() => openCaptureSheet("capture"));
    expect(screen.getByRole("status").textContent).toBe("");
  });
});
