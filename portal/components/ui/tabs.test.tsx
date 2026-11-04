// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { Tabs } from "./tabs";

describe("Tabs", () => {
  const items = [
    { href: "/plan", label: "Plan", active: true },
    { href: "/inbox", label: "Inbox", count: 4, active: false }
  ];

  it("is a navigation of links to each href", () => {
    render(<Tabs items={items} label="Sections" />);
    expect(screen.getByRole("navigation", { name: "Sections" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Plan" }).getAttribute("href")).toBe("/plan");
  });

  it("marks only the active tab as the current page", () => {
    render(<Tabs items={items} />);
    expect(screen.getByRole("link", { name: "Plan" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /Inbox/ }).getAttribute("aria-current")).toBeNull();
  });

  it("shows a count when given", () => {
    render(<Tabs items={items} />);
    expect(screen.getByRole("link", { name: /Inbox/ }).textContent).toContain("4");
  });
});
