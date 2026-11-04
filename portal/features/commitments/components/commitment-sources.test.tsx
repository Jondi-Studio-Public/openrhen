// @vitest-environment jsdom
import "@/test/example-calendar-sources";
import { describe, expect, it, vi } from "vitest";
import type { StoredCommitment } from "@/state/portal-state";
import { fireEvent, render, screen } from "@/test/render";
import { CommitmentSources } from "./commitment-sources";

const base: StoredCommitment = {
  id: "c1",
  version: 2,
  title: "Dentist",
  startsAt: "2026-09-30T00:00:00.000Z",
  endsAt: "2026-09-30T01:00:00.000Z",
  status: "confirmed",
  setupBeforeMinutes: 0,
  transitionAfterMinutes: 0
};
const withSources = (sources: StoredCommitment["sources"]): StoredCommitment => ({ ...base, sources });

describe("Commitment sources", () => {
  it("shows nothing for a hand-entered commitment", () => {
    const { container } = render(<CommitmentSources commitment={base} onSplit={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("lists each source by provider and marks the primary", () => {
    render(
      <CommitmentSources
        commitment={withSources([
          { id: "l1", provider: "example_daily", role: "primary" },
          { id: "l2", provider: "example_shared", role: "secondary" },
          { id: "l3", provider: "google_calendar", role: "secondary" }
        ])}
        onSplit={vi.fn()}
      />
    );
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items[0]).toContain("Example Daily");
    expect(items[0]).toContain("primary");
    expect(items[1]).toContain("Example Shared");
    expect(items[2]).toContain("Google Calendar");
  });

  it("offers Not the same event on each secondary source only, and splits that link", async () => {
    const onSplit = vi.fn().mockResolvedValue(undefined);
    render(
      <CommitmentSources
        commitment={withSources([
          { id: "l1", provider: "example_daily", role: "primary" },
          { id: "l2", provider: "example_shared", role: "secondary" }
        ])}
        onSplit={onSplit}
      />
    );
    const buttons = screen.getAllByRole("button", { name: "Not the same event" });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    await vi.waitFor(() => expect(onSplit).toHaveBeenCalledWith("l2"));
  });

  it("offers no split when there is only one source", () => {
    render(
      <CommitmentSources
        commitment={withSources([{ id: "l1", provider: "example_shared", role: "secondary" }])}
        onSplit={vi.fn()}
      />
    );
    expect(screen.getByText("Example Shared")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Not the same event" })).toBeNull();
  });

  it("says why a split failed", async () => {
    render(
      <CommitmentSources
        commitment={withSources([
          { id: "l1", provider: "example_daily", role: "primary" },
          { id: "l2", provider: "email", role: "secondary" }
        ])}
        onSplit={vi.fn().mockRejectedValue(new Error("This record changed elsewhere. Reload before saving."))}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Not the same event" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed elsewhere");
  });
});
