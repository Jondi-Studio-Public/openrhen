// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/test/render";
import GlobalError from "./global-error";

describe("GlobalError", () => {
  it("renders its heading", () => {
    render(<GlobalError error={new Error("boom")} reset={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "OpenRhen hit a snag." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});
