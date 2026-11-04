// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Banner } from "./banner";

describe("Banner", () => {
  it.each(["neutral", "info", "warn"] as const)("is a polite status for %s", (tone) => {
    render(<Banner tone={tone}>Heads up</Banner>);
    expect(screen.getByRole("status").textContent).toContain("Heads up");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("is an alert for danger", () => {
    render(<Banner tone="danger">Sync failed</Banner>);
    expect(screen.getByRole("alert").textContent).toContain("Sync failed");
  });

  it("renders its action and hides the icon from assistive tech", () => {
    render(
      <Banner icon={<svg data-testid="i" />} action={<button>Retry</button>}>
        Offline
      </Banner>
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByTestId("i").parentElement!.getAttribute("aria-hidden")).toBe("true");
  });
});
