// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { fireEvent, render, screen } from "@/test/render";

const extractAi = vi.fn();
let inbox: Record<string, unknown> | null;

vi.mock("@/features/imports/import-workflow-provider", () => ({
  useImportWorkflowContext: () => (inbox as { imports: unknown }).imports
}));

const { ImportPanels } = await import("./import-panels");

const batch = {
  id: "b1",
  sourceType: "ai_text",
  inputKind: "brain_dump",
  status: "draft",
  version: 1,
  createdAt: "2026-08-23T02:12:58.000Z",
  updatedAt: "2026-08-23T02:12:58.000Z",
  records: [],
  source: {}
};

beforeEach(() => {
  extractAi.mockReset();
  inbox = {
    imports: {
      state: {},
      busy: false,
      aiKind: "brain_dump",
      aiText: "Book the dentist",
      aiImages: [],
      setAiKind: vi.fn(),
      setAiText: vi.fn(),
      setAiImages: vi.fn(),
      referenceScopes: [],
      setReferenceScopes: vi.fn(),
      downloadReferenceFiles: vi.fn(),
      selectFiles: vi.fn(),
      previewCalendarSource: vi.fn(),
      extractAi,
      captureStatus: { error: "", notice: "" },
      intakeStatus: { error: "", notice: "" },
      diagnostics: []
    }
  };
});

describe("ImportPanels", () => {
  it("says a pasted extraction is held as an import batch under Calendar and links there", async () => {
    extractAi.mockResolvedValue(batch);
    const onNavigate = vi.fn();
    render(<ImportPanels panel="paste" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("button", { name: /extract/i }));
    const note = await screen.findByText(/held as an import batch under Calendar/);
    const link = note.closest("p")!.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("/inbox/calendar");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalled();
  });

  it("says nothing about a batch when the extraction produced none", async () => {
    extractAi.mockResolvedValue(null);
    render(<ImportPanels panel="paste" onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /extract/i }));
    await waitFor(() => expect(extractAi).toHaveBeenCalled());
    expect(screen.queryByText(/held as an import batch/)).toBeNull();
  });
});
