// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { ImportCommitPanel } from "./import-commit-panel";

const props = {
  status: "ready" as const,
  busy: false,
  blocking: 0,
  ready: 3,
  calendarCount: 0,
  selectedCalendarCount: 0,
  onSaveDraft: vi.fn(),
  onCommit: vi.fn(),
  onCommitReady: vi.fn(),
  onDownloadErrors: vi.fn()
};

const commitButton = () => screen.getByRole("button", { name: /^(Commit all|Import .*)$/ }) as HTMLButtonElement;
const partialButton = () => screen.getByRole("button", { name: /^Commit \d+ ready/ }) as HTMLButtonElement;

describe("ImportCommitPanel", () => {
  it("commits only a batch the server has called ready", () => {
    const { rerender } = render(<ImportCommitPanel {...props} />);
    expect(commitButton().disabled).toBe(false);
    rerender(<ImportCommitPanel {...props} status="draft" />);
    expect(commitButton().disabled).toBe(true);
  });

  it("offers a partial commit instead of a full one while anything blocks, and the errors alongside", () => {
    const onDownloadErrors = vi.fn();
    const onCommitReady = vi.fn();
    render(
      <ImportCommitPanel
        {...props}
        status="blocked"
        blocking={2}
        ready={5}
        onDownloadErrors={onDownloadErrors}
        onCommitReady={onCommitReady}
      />
    );
    expect(screen.queryByRole("button", { name: "Commit all" })).toBeNull();
    expect(partialButton().textContent).toBe("Commit 5 ready · move 2 blocked to a new batch");
    expect(partialButton().disabled).toBe(false);
    fireEvent.click(partialButton());
    expect(onCommitReady).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Download errors" }));
    expect(onDownloadErrors).toHaveBeenCalledOnce();
  });

  it("will not partially commit when nothing is ready, or before the blocked batch has been saved", () => {
    const { rerender } = render(<ImportCommitPanel {...props} status="blocked" blocking={2} ready={0} />);
    expect(partialButton().disabled).toBe(true);
    rerender(<ImportCommitPanel {...props} status="draft" blocking={2} ready={5} />);
    expect(partialButton().disabled).toBe(true);
    expect(screen.getByText(/Validate and save the draft first/)).toBeTruthy();
  });

  it("hides the error download when nothing is blocking", () => {
    render(<ImportCommitPanel {...props} />);
    expect(screen.queryByRole("button", { name: "Download errors" })).toBeNull();
  });

  it("names the number of selected events for a calendar batch", () => {
    const { rerender } = render(<ImportCommitPanel {...props} calendarCount={3} selectedCalendarCount={1} />);
    expect(commitButton().textContent).toBe("Import 1 selected event");
    rerender(<ImportCommitPanel {...props} calendarCount={3} selectedCalendarCount={2} />);
    expect(commitButton().textContent).toBe("Import 2 selected events");
  });

  it("will not commit a calendar batch with nothing selected", () => {
    render(<ImportCommitPanel {...props} calendarCount={3} selectedCalendarCount={0} />);
    expect(commitButton().disabled).toBe(true);
  });

  it("saves a draft on request and stops once the batch is committed", () => {
    const onSaveDraft = vi.fn();
    const { rerender } = render(<ImportCommitPanel {...props} onSaveDraft={onSaveDraft} />);
    fireEvent.click(screen.getByRole("button", { name: "Validate and save draft" }));
    expect(onSaveDraft).toHaveBeenCalledOnce();
    rerender(<ImportCommitPanel {...props} status="committed" onSaveDraft={onSaveDraft} />);
    expect((screen.getByRole("button", { name: "Validate and save draft" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
