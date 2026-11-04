// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { BareShell, isBarePath } from "./app-shell";

describe("isBarePath", () => {
  it("draws first run without the navigation, and every other page with it", () => {
    expect(isBarePath("/setup")).toBe(true);
    expect(isBarePath("/")).toBe(false);
    expect(isBarePath("/settings")).toBe(false);
    expect(isBarePath(null)).toBe(false);
  });
});

describe("BareShell", () => {
  it("shows the page, with no navigation", () => {
    render(
      <BareShell loadFailed={false}>
        <p>Setup page</p>
      </BareShell>
    );
    expect(screen.getByText("Setup page")).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("keeps the failed-load guard, so setup never saves over state that never loaded", () => {
    render(
      <BareShell loadFailed>
        <p>Setup page</p>
      </BareShell>
    );
    expect(screen.queryByText("Setup page")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Your plan isn't showing" })).toBeTruthy();
  });
});
