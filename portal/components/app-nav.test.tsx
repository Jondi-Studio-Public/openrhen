// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { closeGoTo, useGoToOpen } from "@/shared/use-go-to";
import { AppNav } from "./app-nav";

afterEach(() => closeGoTo());

function GoToProbe() {
  return <p>{useGoToOpen() ? "palette open" : "palette closed"}</p>;
}

describe("AppNav", () => {
  it("shows the five places on the phone tab bar and marks the current one", () => {
    render(<AppNav variant="tabs" pathname="/schedule" onCapture={vi.fn()} />);
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["Now", "Day", "Plan", "Inbox", "You"]);
    expect(within(nav).getByRole("link", { name: "Day" }).getAttribute("aria-current")).toBe("page");
  });

  it("puts a dot on the You tab only when a connection has lapsed", () => {
    const { rerender } = render(<AppNav variant="tabs" pathname="/" onCapture={vi.fn()} />);
    expect(screen.queryByRole("img", { name: "A connection needs attention" })).toBeNull();
    rerender(<AppNav variant="tabs" pathname="/" onCapture={vi.fn()} youAlert />);
    const you = screen.getByRole("link", { name: /You/ });
    expect(within(you).getByRole("img", { name: "A connection needs attention" })).toBeTruthy();
  });

  it("floats Capture on the phone and opens the sheet", () => {
    const onCapture = vi.fn();
    render(<AppNav variant="tabs" pathname="/" onCapture={onCapture} />);
    fireEvent.click(screen.getByRole("button", { name: "Capture a thought" }));
    expect(onCapture).toHaveBeenCalledOnce();
  });

  it("gives the rail a brand link, Go to, the five places and Capture, and no secondary groups", () => {
    render(
      <>
        <AppNav variant="rail" pathname="/settings/routines" onCapture={vi.fn()} />
        <GoToProbe />
      </>
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent)
    ).toEqual(["OpenRhen", "Now", "Day", "Plan", "Inbox", "You"]);
    expect(within(nav).getByRole("link", { name: "You" }).getAttribute("aria-current")).toBe("page");
    expect(within(nav).queryByText("Records")).toBeNull();
    fireEvent.click(within(nav).getByRole("button", { name: /Go to/ }));
    expect(screen.getByText("palette open")).toBeTruthy();
  });

  it("badges the Inbox with what waits for a decision, capped at 99+", () => {
    const { rerender } = render(<AppNav variant="tabs" pathname="/" onCapture={vi.fn()} inboxCount={0} />);
    expect(screen.queryByRole("img", { name: /to review/ })).toBeNull();
    rerender(<AppNav variant="tabs" pathname="/" onCapture={vi.fn()} inboxCount={140} />);
    expect(screen.getByRole("img", { name: "140 to review" }).textContent).toContain("99+");
  });

  it("says in the rail when the plan on screen was worked out, and nowhere else", () => {
    const { rerender } = render(<AppNav variant="rail" pathname="/" onCapture={vi.fn()} planUpdated="8:33 am" />);
    expect(screen.getByText("Plan updated 8:33 am")).toBeTruthy();
    rerender(<AppNav variant="rail" pathname="/" onCapture={vi.fn()} />);
    expect(screen.queryByText(/Plan updated/)).toBeNull();
    rerender(<AppNav variant="tabs" pathname="/" onCapture={vi.fn()} planUpdated="8:33 am" />);
    expect(screen.queryByText(/Plan updated/)).toBeNull();
  });

  it("gives the phone a Go to button of its own, and the rail its search box instead", () => {
    const { unmount } = render(
      <>
        <AppNav variant="tabs" pathname="/" onCapture={vi.fn()} />
        <GoToProbe />
      </>
    );
    fireEvent.click(screen.getByRole("button", { name: "Go to" }));
    expect(screen.getByText("palette open")).toBeTruthy();
    unmount();
    render(<AppNav variant="rail" pathname="/" onCapture={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Go to" })).toBeNull();
  });
});
