// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import { createSeedState } from "@/state/portal-state";
import { settingsSections } from "@/features/settings/settings-sections";

const seed = createSeedState(new Date("2026-08-18T10:00:00.000Z"));
const context = {
  state: { ...seed, settings: { ...seed.settings, preferredBedtime: "22:40", preferredWakeTime: "06:20" } }
};
vi.mock("@/state/portal-provider", () => ({ usePortal: () => context }));

describe("Settings landing page", () => {
  it("lists the eight rows, each opening its first page", async () => {
    const { default: SettingsPage } = await import("./page");
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/settings/sleep",
      "/settings/planning",
      "/settings/catalogues/conditions",
      "/settings/notifications",
      "/settings/disruptions",
      "/settings/ai",
      "/settings/passwords-and-keys",
      "/settings/advanced"
    ]);
    expect(links.map((link) => link.querySelector("span span")?.textContent)).toEqual(
      settingsSections.map((section) => section.title)
    );
  });

  it("shows the sleep times it holds on the sleep row", async () => {
    const { default: SettingsPage } = await import("./page");
    render(<SettingsPage />);
    expect(screen.getByRole("link", { name: /Sleep and routines/ }).textContent).toContain(
      "Bed 10:40 pm · usual wake 6:20 am"
    );
  });

  it("reaches every settings page from some row", () => {
    const pages = settingsSections.flatMap((section) => section.pages.map((page) => page.href));
    for (const href of [
      "/settings/sleep",
      "/settings/routines",
      "/settings/planning",
      "/settings/planning/buffers",
      "/settings/planning/estimates",
      "/settings/catalogues/energy",
      "/settings/catalogues/conditions",
      "/settings/disruptions",
      "/settings/family-calendar",
      "/settings/pulse",
      "/settings/notifications",
      "/settings/ai",
      "/settings/passwords-and-keys",
      "/settings/advanced"
    ])
      expect(pages, href).toContain(href);
  });
});
