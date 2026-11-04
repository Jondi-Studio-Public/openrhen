// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { RoutineEmptyState } from "@/features/routines/components/routine-empty-state";

describe("RoutineEmptyState", () => {
  it("offers the way in rather than a blank panel", () => {
    const onCreate = vi.fn();
    render(<RoutineEmptyState onCreate={onCreate} />);
    expect(screen.getByRole("heading", { name: "Choose or create a routine" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
