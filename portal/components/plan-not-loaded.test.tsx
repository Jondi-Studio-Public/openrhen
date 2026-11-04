// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { PlanNotLoaded } from "./plan-not-loaded";

describe("PlanNotLoaded", () => {
  it("says nothing was lost and retries on Retry", () => {
    const onRetry = vi.fn();
    render(<PlanNotLoaded onRetry={onRetry} />);
    expect(screen.getByRole("heading", { level: 1, name: "Your plan isn't showing" })).toBeTruthy();
    expect(screen.getByText(/Nothing has been changed or lost/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
