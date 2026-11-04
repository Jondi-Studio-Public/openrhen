// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { closeCaptureSheet, openCaptureSheet } from "@/shared/use-capture-sheet";

vi.mock("@/state/portal-provider", () => ({
  usePortal: () => ({
    state: { captures: [] },
    addCapture: vi.fn(),
    saveEntityCommand: vi.fn(),
    runActivityCommand: vi.fn()
  })
}));
vi.mock("@/features/disruptions/components/disruption-capture-form", () => ({
  DisruptionCaptureForm: () => <p>disruption form</p>
}));
// The real provider and panels run; only the network-backed workflow underneath is a stand-in that
// keeps its text in state the way the real one does, and counts how many instances were made.
const made = vi.fn();
vi.mock("@/features/imports/use-import-workflow", () => ({
  useImportWorkflow: () => {
    const [aiText, setAiText] = useState("");
    useState(() => made());
    return {
      state: {},
      busy: false,
      aiKind: "brain_dump",
      aiText,
      aiImages: [],
      setAiKind: vi.fn(),
      setAiText,
      setAiImages: vi.fn(),
      referenceScopes: [],
      setReferenceScopes: vi.fn(),
      downloadReferenceFiles: vi.fn(),
      selectFiles: vi.fn(),
      previewCalendarSource: vi.fn(),
      extractAi: vi.fn(),
      captureStatus: { error: "", notice: "" },
      intakeStatus: { error: "", notice: "" },
      diagnostics: []
    };
  }
}));

const { ImportWorkflowProvider, useImportWorkflowContext } =
  await import("@/features/imports/import-workflow-provider");
const { CaptureSheetDialog } = await import("./capture-sheet-dialog");

/** Stands in for the Inbox, which reads the same context its queue is built from. */
function InboxQueueProbe() {
  return <p data-testid="inbox-text">{useImportWorkflowContext().aiText}</p>;
}

afterEach(() => act(() => closeCaptureSheet()));

function mount() {
  render(
    <ImportWorkflowProvider>
      <InboxQueueProbe />
      <CaptureSheetDialog />
    </ImportWorkflowProvider>
  );
  act(() => openCaptureSheet("paste"));
}

describe("the sheet's imports under the shell's workflow provider", () => {
  it("shares one workflow with the Inbox, so what the sheet holds is what the Inbox sees", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText(/Paste notes/), { target: { value: "Book the dentist" } });
    expect(screen.getByTestId("inbox-text").textContent).toBe("Book the dentist");
    expect(made).toHaveBeenCalledTimes(1);
  });

  it("keeps pasted work across a switch to Capture and back", () => {
    mount();
    fireEvent.change(screen.getByPlaceholderText(/Paste notes/), { target: { value: "Book the dentist" } });
    fireEvent.click(screen.getByRole("tab", { name: "Capture" }));
    expect(screen.queryByPlaceholderText(/Paste notes/)).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Something came up" }));
    fireEvent.click(screen.getByRole("tab", { name: "Paste or photo" }));
    expect((screen.getByPlaceholderText(/Paste notes/) as HTMLTextAreaElement).value).toBe("Book the dentist");
  });
});
