// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { SourcePanel } from "./source-panel";
import { deliverable } from "@/features/deliverables/test-fixtures";

const withFile = deliverable({
  sourceFiles: [
    {
      id: "file-1",
      sourceId: "source-1",
      filename: "brief.pdf",
      mimeType: "application/pdf",
      byteSize: 2048,
      createdAt: "2026-08-18T00:00:00.000Z"
    }
  ]
});

describe("SourcePanel", () => {
  it("lists retained files with ownership-checked links and no composer when not editable", () => {
    render(<SourcePanel deliverable={withFile} editable={false} disabled={false} onAttach={vi.fn()} />);
    expect(screen.getByRole("link", { name: /brief\.pdf/ }).getAttribute("href")).toBe(
      "/api/deliverable-source-files/file-1"
    );
    expect(screen.queryByRole("button", { name: /conversation/ })).toBeNull();
  });

  it("no longer offers the one-shot bulk extraction", () => {
    render(<SourcePanel deliverable={withFile} editable disabled={false} onAttach={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Extract requirements/ })).toBeNull();
    expect(screen.getByText(/read by the assistant on every turn/i)).toBeTruthy();
  });

  it("attaches the named source to the conversation and clears the composer afterwards", async () => {
    const onAttach = vi.fn().mockResolvedValue(undefined);
    render(<SourcePanel deliverable={withFile} editable disabled={false} onAttach={onAttach} />);
    const button = screen.getByRole("button", { name: "Add source to the conversation" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Source name"), { target: { value: "Rubric" } });
    fireEvent.change(screen.getByLabelText("Paste source text"), { target: { value: "Demonstrate connectivity." } });
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(onAttach).toHaveBeenCalledWith({ sourceTitle: "Rubric", text: "Demonstrate connectivity.", files: [] });
    expect((screen.getByLabelText("Paste source text") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByLabelText("Source name") as HTMLInputElement).value).toBe("");
  });

  it("stays disabled while a draft is unsaved and reports a failed attachment", async () => {
    const onAttach = vi.fn().mockRejectedValue(new Error("Source retention is not configured."));
    const { rerender } = render(<SourcePanel deliverable={withFile} editable disabled onAttach={onAttach} />);
    fireEvent.change(screen.getByLabelText("Source name"), { target: { value: "Rubric" } });
    fireEvent.change(screen.getByLabelText("Paste source text"), { target: { value: "x" } });
    expect((screen.getByRole("button", { name: /conversation/ }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<SourcePanel deliverable={withFile} editable disabled={false} onAttach={onAttach} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /conversation/ }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Source retention is not configured.");
  });
});
