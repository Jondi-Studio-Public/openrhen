// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import NotFound from "./not-found";

describe("not found page", () => {
  it("says the address is not a page and links back to Now", () => {
    render(<NotFound />);
    expect(screen.getByText("There is no page at this address.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Go to Now" }).getAttribute("href")).toBe("/");
  });
});
