// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { ActionBar } from "./action-bar";

describe("ActionBar", () => {
  it("wraps a panel so its actions row is a direct child of the docking scope", () => {
    const { container } = render(
      <ActionBar className="now-actions">
        <p className="reason">Why</p>
        <div className="actions">
          <button>Start</button>
        </div>
      </ActionBar>
    );
    const bar = container.querySelector(".action-bar")!;
    expect(bar.className).toBe("action-bar now-actions");
    expect(screen.getByRole("button", { name: "Start" }).parentElement!.parentElement).toBe(bar);
  });

  describe("the docked height", () => {
    afterEach(() => vi.restoreAllMocks());
    const root = () => document.documentElement.style.getPropertyValue("--docked-actions-height");

    it("publishes the docked row's real height, and takes it back when the bar goes", () => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(176);
      const { unmount } = render(
        <ActionBar>
          <div className="actions" style={{ position: "fixed" }}>
            <button>Start</button>
            <p>The plan is not refreshing.</p>
          </div>
        </ActionBar>
      );
      expect(root()).toBe("176px");
      unmount();
      expect(root()).toBe("");
    });

    it("publishes nothing while the row sits in place, as it does on a desk", () => {
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(176);
      render(
        <ActionBar>
          <div className="actions">
            <button>Start</button>
          </div>
        </ActionBar>
      );
      expect(root()).toBe("");
    });
  });
});
