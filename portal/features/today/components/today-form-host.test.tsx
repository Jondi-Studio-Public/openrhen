// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { TodayFormHost } from "./today-form-host";

describe("Today form host", () => {
  it("renders the form inline on a desk without any dialog", () => {
    render(
      <TodayFormHost phone={false} open={false} title="Add fixed commitment" onClose={vi.fn()}>
        <form aria-label="commitment" />
      </TodayFormHost>
    );
    expect(screen.getByRole("form", { name: "commitment" })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector(".today-form-sheet")).toBeNull();
  });

  it("holds the form in a titled sheet on a phone while open and renders nothing while closed", () => {
    const { rerender } = render(
      <TodayFormHost phone open={false} title="Add fixed commitment" onClose={vi.fn()}>
        <form aria-label="commitment" />
      </TodayFormHost>
    );
    expect(screen.queryByRole("form", { name: "commitment" })).toBeNull();
    rerender(
      <TodayFormHost phone open title="Add fixed commitment" onClose={vi.fn()}>
        <form aria-label="commitment" />
      </TodayFormHost>
    );
    const dialog = screen.getByRole("dialog", { name: "Add fixed commitment" });
    expect(dialog.className).toContain("today-form-sheet");
    expect(screen.getByRole("form", { name: "commitment" })).toBeTruthy();
  });

  it("closes through the sheet's own controls", () => {
    const onClose = vi.fn();
    render(
      <TodayFormHost phone open title="Add capacity window" onClose={onClose}>
        <input aria-label="Starts" />
      </TodayFormHost>
    );
    fireEvent.click(screen.getByRole("button", { name: "Close Add capacity window" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
