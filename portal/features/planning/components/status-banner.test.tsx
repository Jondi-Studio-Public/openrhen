// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/test/render";
import { SLOW_WORKING_MS, StatusBanner } from "./status-banner";

afterEach(() => {
  vi.useRealTimers();
});

describe("StatusBanner", () => {
  it("is a polite status for working and warning, and an alert only for danger", () => {
    const { container, rerender } = render(<StatusBanner tone="working" text="Working out your plan…" />);
    expect(screen.getByRole("status").className).toBe("status-banner tone-working");
    rerender(<StatusBanner tone="warning" text="Old plan" />);
    expect(screen.getByRole("status").className).toBe("status-banner tone-warning");
    rerender(<StatusBanner tone="danger" text="Failed" />);
    expect(screen.getByRole("alert").className).toBe("status-banner tone-danger");
    expect(container.querySelectorAll(".status-banner")).toHaveLength(1);
  });

  it("publishes its height for the nav rail, follows a change of tone, and clears it when it goes", () => {
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(68);
    const root = document.documentElement.style;
    const { rerender, unmount } = render(<StatusBanner tone="working" text="Working out your plan…" />);
    expect(root.getPropertyValue("--status-banner-height")).toBe("68px");
    height.mockReturnValue(96);
    rerender(<StatusBanner tone="danger" text="Failed" />);
    expect(root.getPropertyValue("--status-banner-height")).toBe("96px");
    unmount();
    expect(root.getPropertyValue("--status-banner-height")).toBe("");
    height.mockRestore();
  });

  it("asks whether the worker is running once a wait passes a minute, and drops it when the wait ends", () => {
    vi.useFakeTimers();
    const { rerender } = render(<StatusBanner tone="working" text="Working out your plan…" />);
    expect(screen.queryByRole("link", { name: "Check Connections" })).toBeNull();
    act(() => vi.advanceTimersByTime(SLOW_WORKING_MS));
    expect(screen.getByText(/Is the planner worker running\?/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Check Connections" }).getAttribute("href")).toBe("/connections");
    rerender(<StatusBanner tone="warning" text="Old plan" />);
    expect(screen.queryByRole("link", { name: "Check Connections" })).toBeNull();
  });
});
