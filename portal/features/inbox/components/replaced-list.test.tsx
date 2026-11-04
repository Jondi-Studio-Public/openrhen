// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { ReplacedList } from "./replaced-list";

const rows = [
  {
    id: "a",
    title: "Book the site visit",
    detail: "email change · replaced by a later reading of the thread",
    outcome: "replaced",
    at: "2026-08-17T00:00:00.000Z"
  },
  {
    id: "b",
    title: "Send the quote",
    detail: "email change · replaced by a later reading of the thread",
    outcome: "replaced",
    at: "2026-08-16T00:00:00.000Z"
  }
];

describe("ReplacedList", () => {
  it("counts its rows and offers Restore on each", () => {
    const { container } = render(<ReplacedList rows={rows} onRestore={vi.fn()} />);
    expect(container.querySelector("summary")!.textContent).toContain("Replaced");
    expect(container.querySelector("summary")!.textContent).toContain("2");
    expect(screen.getByRole("button", { name: "Restore Book the site visit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Restore Send the quote" })).toBeTruthy();
  });

  it("restores the row that was pressed, and only that one", () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);
    render(<ReplacedList rows={rows} onRestore={onRestore} />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Send the quote" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith("b");
  });

  it("shows a failed restore and says what an empty list means", () => {
    const { rerender } = render(
      <ReplacedList rows={rows} error="Only a replaced proposal can be restored." onRestore={vi.fn()} />
    );
    expect(screen.getByRole("alert").textContent).toContain("Only a replaced proposal can be restored.");
    rerender(<ReplacedList rows={[]} onRestore={vi.fn()} />);
    expect(screen.getByText("Nothing replaced in the last 7 days.")).toBeTruthy();
  });
});
