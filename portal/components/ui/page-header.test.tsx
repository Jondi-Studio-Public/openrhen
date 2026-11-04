// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("has the title as the page's h1", () => {
    render(<PageHeader title="Today" />);
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeTruthy();
  });

  it("shows the answer line and actions when given", () => {
    render(<PageHeader title="Today" answer="Three hours free." actions={<button>Add</button>} />);
    expect(screen.getByText("Three hours free.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("is a banner-free header with no empty answer or actions", () => {
    const { container } = render(<PageHeader title="Plan" />);
    expect(container.querySelector("p")).toBeNull();
  });
});
