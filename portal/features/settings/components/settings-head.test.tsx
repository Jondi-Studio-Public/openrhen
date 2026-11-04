// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { SettingsHead } from "./settings-head";
import { clockLabel } from "../settings-sections";

describe("SettingsHead", () => {
  it("titles a page after its row and shows its siblings as tabs, the current one marked", () => {
    render(<SettingsHead href="/settings/planning/buffers" answer="Protected time." />);
    expect(screen.getByRole("heading", { level: 1, name: "Planning" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "You" }).getAttribute("href")).toBe("/you");
    const nav = screen.getByRole("navigation", { name: "Planning" });
    expect([...nav.querySelectorAll("a")].map((a) => a.textContent)).toEqual(["Planning", "Buffers", "Estimates"]);
    expect(screen.getByRole("link", { name: "Buffers" }).getAttribute("aria-current")).toBe("page");
  });

  it("draws no tabs for a row with one page", () => {
    render(<SettingsHead href="/settings/notifications" />);
    expect(screen.getByRole("heading", { level: 1, name: "Notifications" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});

describe("clockLabel", () => {
  it("reads a 24-hour time as a 12-hour one", () => {
    expect(clockLabel("22:40")).toBe("10:40 pm");
    expect(clockLabel("06:20")).toBe("6:20 am");
    expect(clockLabel("00:05")).toBe("12:05 am");
    expect(clockLabel("12:00")).toBe("12:00 pm");
  });
});
