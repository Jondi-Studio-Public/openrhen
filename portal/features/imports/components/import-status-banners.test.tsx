// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { ImportStatusBanners } from "./import-status-banners";

describe("ImportStatusBanners", () => {
  it("shows nothing when there is nothing to say", () => {
    const { container } = render(<ImportStatusBanners error="" success={null} notice="" />);
    expect(container.textContent).toBe("");
  });

  it("announces a failure as an alert", () => {
    render(<ImportStatusBanners error="Preview failed." success={null} notice="" />);
    expect(screen.getByRole("alert").textContent).toBe("Preview failed.");
  });

  it("counts a single imported record in the singular", () => {
    render(<ImportStatusBanners error="" success={{ count: 1, message: "All done." }} notice="" />);
    expect(screen.getByText("1 record")).toBeTruthy();
  });

  it("counts several imported records in the plural and repeats the server message", () => {
    render(<ImportStatusBanners error="" success={{ count: 4, message: "All done." }} notice="" />);
    expect(screen.getByText("4 records")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("All done.");
  });

  it("shows a draft notice alongside an error", () => {
    render(<ImportStatusBanners error="Draft save failed." success={null} notice="Draft validated and saved." />);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("Draft validated and saved.")).toBeTruthy();
  });

  it("says nothing at all when it is given only the messages of another panel", () => {
    const { container } = render(<ImportStatusBanners error="" notice="" />);
    expect(container.textContent).toBe("");
  });

  it("lists what a file gave up as a warning that does not claim anything failed", () => {
    const { container } = render(
      <ImportStatusBanners
        error=""
        notice=""
        warnings={['Areas: the column "sort_ordr" is not an import column and was ignored.']}
      />
    );
    expect(container.querySelector(".form-error")).toBeNull();
    expect(screen.getByText("1 thing in the file was ignored")).toBeTruthy();
    expect(screen.getByRole("listitem").textContent).toContain("sort_ordr");
  });

  it("counts several ignored things in the plural", () => {
    render(<ImportStatusBanners error="" notice="" warnings={["one", "two"]} />);
    expect(screen.getByText("2 things in the file were ignored")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
