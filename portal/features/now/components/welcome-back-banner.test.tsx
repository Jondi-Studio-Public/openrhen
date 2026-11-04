// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { WelcomeBackBanner } from "./welcome-back-banner";

const rows = [
  { key: "catch-up", label: "3 things to settle", count: 3, href: "/catch-up" },
  { key: "inbox", label: "5 waiting in Inbox", count: 5, href: "/inbox" }
];

describe("WelcomeBackBanner", () => {
  it("says what is waiting in one line and goes to the first thing, with the rest behind See all", () => {
    const markSeen = vi.fn();
    render(
      <WelcomeBackBanner
        show
        awaySince="2026-10-24T00:00:00.000Z"
        rows={rows}
        markSeen={markSeen}
        timezone="Australia/Sydney"
      />
    );
    expect(screen.getByRole("status").textContent).toContain(
      "You've been away since Saturday 24 October. 3 things to settle, 5 waiting in Inbox."
    );
    expect(screen.getByRole("link", { name: "Catch up" }).getAttribute("href")).toBe("/catch-up");
    fireEvent.click(screen.getByRole("button", { name: "See all" }));
    expect(screen.getByRole("link", { name: /3 things to settle/ }).getAttribute("href")).toBe("/catch-up");
    expect(screen.getByRole("link", { name: /5 waiting in Inbox/ }).getAttribute("href")).toBe("/inbox");
    expect(markSeen).not.toHaveBeenCalled();
  });

  it("has no See all when there is one thing", () => {
    render(
      <WelcomeBackBanner show awaySince={null} rows={rows.slice(1)} markSeen={() => {}} timezone="Australia/Sydney" />
    );
    expect(screen.getByRole("link", { name: "Catch up" }).getAttribute("href")).toBe("/inbox");
    expect(screen.queryByRole("button", { name: "See all" })).toBeNull();
  });

  it("marks it seen when dismissed", () => {
    const markSeen = vi.fn();
    render(<WelcomeBackBanner show awaySince={null} rows={rows} markSeen={markSeen} timezone="Australia/Sydney" />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(markSeen).toHaveBeenCalledTimes(1);
  });

  it("shows nothing when there is nothing to come back to", () => {
    const { container } = render(
      <WelcomeBackBanner show awaySince={null} rows={[]} markSeen={() => {}} timezone="Australia/Sydney" />
    );
    expect(container.textContent).toBe("");
  });
});
