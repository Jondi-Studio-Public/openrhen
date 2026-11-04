// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@/test/render";
import { LoggedToast } from "./logged-toast";

describe("LoggedToast", () => {
  it("says what was logged, with no Undo", () => {
    render(<LoggedToast logged={{ key: "k1", title: "Write the report", minutes: 42 }} />);
    expect(screen.getByText("Logged 42 min on Write the report")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows nothing when nothing was logged", () => {
    render(<LoggedToast logged={null} />);
    expect(screen.queryByText(/^Logged/)).toBeNull();
  });
});
