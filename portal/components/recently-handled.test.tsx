// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { RecentlyHandled } from "./recently-handled";

describe("RecentlyHandled", () => {
  it("is folded closed, counts its rows and lists each with its outcome", () => {
    const { container } = render(
      <RecentlyHandled
        rows={[
          { id: "a", title: "Dentist visit", detail: "action", outcome: "confirmed", at: "2026-08-17T00:00:00.000Z" },
          { id: "b", title: "Old note", detail: "unclassified", outcome: "ignored", at: "2026-08-16T00:00:00.000Z" }
        ]}
      />
    );
    const fold = container.querySelector<HTMLDetailsElement>("details")!;
    expect(fold.open).toBe(false);
    expect(fold.querySelector("summary")!.textContent).toContain("Recently handled");
    expect(fold.querySelector("summary")!.textContent).toContain("2");
    expect(screen.getByText("confirmed").className).toContain("proposal-status confirmed");
    expect(screen.getByText("ignored")).toBeTruthy();
  });

  it("says what an empty list means", () => {
    render(<RecentlyHandled rows={[]} empty="Nothing here yet." />);
    expect(screen.getByText("Nothing here yet.")).toBeTruthy();
  });
});
